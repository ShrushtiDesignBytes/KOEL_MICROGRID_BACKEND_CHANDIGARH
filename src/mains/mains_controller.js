var db = require('../../config/db');
const Mains = db.mains;
const sequelize = db.sequelize;
const { Op, literal, col, fn } = require('sequelize');

module.exports = {

    //get all mains
    getMains: async (req, res) => {
        try {
            const result = await Mains.sequelize.query(`
                WITH hourly_avg AS (
                     SELECT 
                     DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,
                     AVG(
                             (("kW"->>'phase1')::FLOAT + 
                             ("kW"->>'phase2')::FLOAT + 
                             ("kW"->>'phase3')::FLOAT)
                         ) AS avg_kW_per_hour
                     FROM main
                     WHERE "createdAt" >= CURRENT_DATE
                     AND "createdAt" < CURRENT_DATE + INTERVAL '1 day'
                     GROUP BY hour
                 )
                 SELECT SUM(avg_kW_per_hour) AS avg_daily_total_generations FROM hourly_avg;
 
             `, {
                type: sequelize.QueryTypes.SELECT
            });

            const daily_generation = result[0].avg_daily_total_generations;

            const result_power = await Mains.sequelize.query(`
                WITH hourly_avg AS (
                    SELECT 
                    DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,
                    AVG(
                            (("kW"->>'phase1')::FLOAT + 
                            ("kW"->>'phase2')::FLOAT + 
                            ("kW"->>'phase3')::FLOAT)
                        ) AS avg_kW_per_hour
                    FROM main
                    WHERE "createdAt" >= CURRENT_DATE - INTERVAL '1 day'  -- Filter for yesterday's data
                    AND "createdAt" < CURRENT_DATE  -- Exclude today's data
                    GROUP BY hour
                )
                SELECT SUM(avg_kW_per_hour) AS power_generations_yesterday 
                FROM hourly_avg;
 
             `, {
                type: sequelize.QueryTypes.SELECT
            });

            const power_generation_yesterday = result_power[0].power_generations_yesterday;

            const result_hours = await Mains.sequelize.query(
                `SELECT 
                COUNT(DISTINCT DATE_TRUNC('minute', "createdAt")) AS count 
                FROM Main
                WHERE "createdAt" >= CURRENT_DATE - INTERVAL '1 day'               
                AND "createdAt" < CURRENT_DATE                                 
                AND ("kW"->>'phase1')::float > 0                              
                AND ("kW"->>'phase2')::float > 0                                
                AND ("kW"->>'phase3')::float > 0;                                         
              `,
                { type: Mains.sequelize.QueryTypes.SELECT }
            );

            const totalHours = result_hours[0].count / 60.0;
            const hours = Math.floor(totalHours);

            const minutesFraction = Math.round((totalHours - hours) * 60);
            const minute = minutesFraction / 100

            const formattedTime = hours + minute;

            const result_operating_hours = await Mains.sequelize.query(
                `WITH phase1_zero_intervals AS (
                    SELECT 
                        "createdAt",
                        LAG("createdAt") OVER (ORDER BY "createdAt") AS previous_time
                    FROM main
                    WHERE (voltagel->>'phase1')::numeric = 0
                ),
                time_differences AS (
                    SELECT 
                        "createdAt",
                        previous_time,
                    EXTRACT(EPOCH FROM ("createdAt" - previous_time)) AS duration_in_seconds
                    FROM phase1_zero_intervals
                    WHERE previous_time IS NOT NULL
                )
                SELECT 
                    SUM(duration_in_seconds) / 3600 AS total_operating_hours
                FROM time_differences;                                      
              `,
                { type: Mains.sequelize.QueryTypes.SELECT }
            );

            const operating_time = result_operating_hours[0]?.total_operating_hours || 0;

            const result_total = await Mains.sequelize.query(`
                WITH hourly_avg AS (
                    SELECT 
                    DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,  -- Truncate to the hour with IST adjustment
                    AVG(
                            (("kW"->>'phase1')::FLOAT + 
                            ("kW"->>'phase2')::FLOAT + 
                            ("kW"->>'phase3')::FLOAT)
                        ) AS avg_kW_per_hour  -- Calculate the average kW per hour
                    FROM 
                    main
                    WHERE 
                        "createdAt" >= (SELECT MIN("createdAt") FROM Main)  -- Start from the earliest available data
                        AND "createdAt" <= CURRENT_TIMESTAMP  -- Until current time
                    GROUP BY 
                        hour  -- Group by the truncated hour
                    )
                    SELECT 
                        SUM(avg_kW_per_hour) AS total_generation  -- Sum of all hourly averages
                    FROM 
                    hourly_avg;
            `, {
                type: sequelize.QueryTypes.SELECT
            });

            const total = result_total[0].total_generation;

            const result_power_before = await Mains.sequelize.query(`
                           WITH hourly_avg AS (
                               SELECT 
                               DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,
                               AVG(
                                       (("kW"->>'phase1')::FLOAT + 
                                       ("kW"->>'phase2')::FLOAT + 
                                       ("kW"->>'phase3')::FLOAT)
                                   ) AS avg_kW_per_hour
                               FROM main
                               WHERE "createdAt" >= CURRENT_DATE - INTERVAL '2 day'  -- Filter for yesterday's data
                                AND "createdAt" < CURRENT_DATE - INTERVAL '1 day'  -- Exclude today's data
                               GROUP BY hour
                           )
                           SELECT SUM(avg_kW_per_hour) AS power_generations_yesterday 
                           FROM hourly_avg;
                        `, {
                type: sequelize.QueryTypes.SELECT
            });

            const power_generation_before_yesterday = result_power_before[0].power_generations_yesterday;

            const mains = await Mains.findOne({
                order: [['id', 'DESC']],
                limit: 1
            });

            const kwh = await Mains.findOne({
                where: {
                    kwh: {
                        [Op.ne]: null,
                        [Op.ne]: 0
                    }
                },
                order: [['createdAt', 'DESC']]
            });

            const firstRow = await Mains.findOne({
                order: [['id', 'ASC']],
                where: {
                    kwh: {
                        [Op.ne]: null,
                        [Op.ne]: 0
                    }
                },
                attributes: ['kwh'],
            });

            const lastRow = await Mains.findOne({
                order: [['id', 'DESC']],
                where: {
                    kwh: {
                        [Op.ne]: null,
                        [Op.ne]: 0
                    }
                },
                attributes: ['kwh'],
            });


            if (firstRow && lastRow) {
                const kwhDifference = lastRow.kwh - firstRow.kwh;
                mains.dataValues.kwh_diff = kwhDifference;
            }

            if (kwh) {
                mains.dataValues.kwh = kwh.dataValues.kwh;
            }

            if(mains.dataValues.breaker_status === null){
                mains.dataValues.breaker_status = 'OFF'
            }

            if (mains && result) {
                mains.dataValues.avg_daily_total_generation = Math.floor(daily_generation);
            }

            if (result_total) {
                mains.dataValues.avg_total_generation = Math.floor(total);
            }

            if (result_power) {
                mains.dataValues.power_generated_yesterday = power_generation_yesterday;
            }

            if (result_power) {
                mains.dataValues.power_generated_before_yesterday = power_generation_before_yesterday;
            }

            if (result_hours) {
                mains.dataValues.hours_operated_yesterday = formattedTime.toFixed(2);
            }

            if (result_operating_hours) {
                mains.dataValues.operating_hours = parseFloat(operating_time).toFixed(2);
            }

            await Mains.update(
                {
                    operating_hours: parseFloat(operating_time).toFixed(2),
                    hours_operated: formattedTime.toFixed(2)
                },
                { where: { id: mains.id } }
            );

            return res.status(200).send(
                [mains]
            );
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }
    },

    //add mains
    createMains: async (req, res) => {
        const mainsArray = req.body;

        try {
            const createdMains = [];

            for (const mainsdata of mainsArray) {
                const { breaker_status, frequency, current, kVA, kW, maintainance_last_date, next_due, operating_hours, power_factor, voltagel, voltagen, hours_operated, kwh, unit_generated } = mainsdata;

                const { id, ...filteredData } = mainsdata;

                //console.log('data', filteredData)

                const localID = await Mains.findOne({
                    where: {
                        localId: id
                    }
                });

                //console.log(localID)

                if (localID !== null) {
                    await Mains.update(filteredData,
                        {
                            where: {
                                localId: id
                            }
                        });

                    createdMains.push('Updated Succesfully')
                } else {
                    try {
                        const result = await sequelize.query(
                            `CALL insert_unique_mains(
                            :v_breaker_status,
                            :v_frequency,
                            :v_current,
                            :v_kVA,
                            :v_kW,
                            :v_maintainance_last_date,
                            :v_next_due,
                            :v_operating_hours,
                            :v_power_factor,
                            :v_voltagel,
                            :v_voltagen,
                            :v_hours_operated,
                            :v_localId,
                            :v_kwh,
                            :v_unit_generated,
                            :result_json
                        )`, {
                            replacements: {
                                v_breaker_status: breaker_status,
                                v_frequency: frequency,
                                v_current: JSON.stringify(current),
                                v_kVA: JSON.stringify(kVA),
                                v_kW: JSON.stringify(kW),
                                v_maintainance_last_date: maintainance_last_date,
                                v_next_due: next_due,
                                v_operating_hours: operating_hours,
                                v_power_factor: power_factor,
                                v_voltagel: JSON.stringify(voltagel),
                                v_voltagen: JSON.stringify(voltagen),
                                v_hours_operated: hours_operated,
                                v_localId: id,
                                v_kwh: kwh,
                                v_unit_generated: unit_generated,
                                result_json: null
                            },
                            type: sequelize.QueryTypes.RAW
                        });

                        const mains = result[0][0].result_json;

                        const data = mains === null ? 'Already saved same data in database' : mains;
                        createdMains.push(data);

                    } catch (innerError) {
                        createdMains.push({ error: `Failed to process data for genset: ${innerError.message}` });
                    }
                }
            }
            return res.status(200).send(createdMains);
        } catch (error) {
            console.log(error)
            return res.status(400).json(
                error.message
            );
        }
    },

    //view mains by id
    viewMains: async (req, res) => {
        const id = req.params.id
        try {
            const mains = await Mains.findByPk(id);
            return res.status(200).send(
                mains
            );
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }

    },

    //delete mains by id
    deleteMains: async (req, res) => {
        const id = req.params.id;
        try {
            const mains = await Mains.destroy({ where: { id } });
            return res.status(200).send({
                message: 'Deleted Successfully'
            });
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }
    },

    //mains update by id
    updateMains: async (req, res) => {
        const id = req.params.id;
        const { breaker_status, frequency, current, kVA, kW, maintainance_last_date, next_due, notification_alarms, operating_hours, power_factor, shutdown, total_generation, total_saving, total_utilisation, utilisation, voltagel, voltagen, hours_operated, power_generated, daily_generation } = req.body;
        try {
            const mains = await Mains.update({
                breaker_status, frequency, current, kVA, kW, maintainance_last_date, next_due, notification_alarms, operating_hours, power_factor, shutdown, total_generation, total_saving, total_utilisation, utilisation, voltagel, voltagen, hours_operated, power_generated, daily_generation
            },
                {
                    where: { id }
                });
            return res.status(200).send({
                message: 'Updated Successfully'
            });
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }
    },
    getChartData: async (req, res) => {
        try {
            const { fromDate, toDate } = req.body;

            const data = await Mains.sequelize.query(
                `WITH hours AS (
                        SELECT 
                        TO_CHAR(generated_hour + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:00:00') AS hour
                        FROM generate_series(
                            (DATE_TRUNC('day', ${fromDate ? `'${fromDate}'` : 'NOW()'} AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 hour') 
                            AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC',
                            ${toDate ? `'${toDate}'` : 'NOW()'} AT TIME ZONE 'UTC',
                            INTERVAL '1 hour'
                        ) AS generated_hour
                    )
                    SELECT 
                    h.hour,
                    COALESCE(SUM(
                        GREATEST(("kW"->>'phase1')::NUMERIC, 0) + 
                        GREATEST(("kW"->>'phase2')::NUMERIC, 0) + 
                        GREATEST(("kW"->>'phase3')::NUMERIC, 0)
                    ), 0) AS totalPower,
                    COALESCE(AVG(
                        GREATEST(("kW"->>'phase1')::NUMERIC, 0) + 
                        GREATEST(("kW"->>'phase2')::NUMERIC, 0) + 
                        GREATEST(("kW"->>'phase3')::NUMERIC, 0)
                    ), 0) AS averagePower
                    FROM hours h
                    LEFT JOIN main s ON 
                        TO_CHAR(s."createdAt" + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:00:00') = h.hour
                    GROUP BY h.hour
                    ORDER BY h.hour;
              `,
                { type: Mains.sequelize.QueryTypes.SELECT }
            );

            // Function to convert the data
            function transformData(rawData) {
                return rawData.map(item => {
                    const hour = new Date(item.hour).getHours();

                    const power = Math.floor(parseFloat(item.averagepower));

                    return {
                        hour: hour,
                        power: power
                    };
                });
            }


            const transformedData = transformData(data);

            res.status(200).json(transformedData);

        } catch (error) {
            console.error('Error fetching power data:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    },

    excelData: async (req, res) => {
        try {
            const { fromDate, toDate } = req.body;

            const data = await Mains.sequelize.query(
                `WITH hours AS (
                     -- Generate hourly timestamps within the given date range
                    SELECT 
                    TO_CHAR(generated_hour + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:00:00') AS hour
                    FROM generate_series(
                        (DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 hour') 
                        AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC',
                        NOW() AT TIME ZONE 'UTC',
                        INTERVAL '1 hour'
                    ) AS generated_hour
                )

            , power_data AS (
                -- Aggregate power data per hour
                SELECT 
                TO_CHAR(s."createdAt" + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:00:00') AS hour,
                MAX(s.unit_generated) AS unit_generated,  -- Get the maximum unit_generated per hour
                MAX(s.kwh) AS kwh         -- Get the latest kWh_reading per hour
                FROM main s
                GROUP BY hour
            )

            SELECT 
                h.hour,
                    COALESCE(p.unit_generated, 0) AS unit_generation, -- Take the maximum per 5 minutes
                    CASE 
                WHEN (
                    (LAG(p.unit_generated) OVER (ORDER BY h.hour) = 0 AND p.unit_generated > 0) 
                    OR 
                    (LAG(p.unit_generated) OVER (ORDER BY h.hour) > 0 AND p.unit_generated = 0)
                )
                THEN 0
                ELSE COALESCE(ABS(p.kwh - LAG(p.kwh) OVER (ORDER BY h.hour)), 0)
                END AS kwh_reading
            FROM hours h
            LEFT JOIN power_data p ON h.hour = p.hour
            ORDER BY h.hour;

        `,
                { type: Mains.sequelize.QueryTypes.SELECT }
            );

            //console.log(data)

            // Function to convert the data
            function transformData(rawData) {
                return rawData.map(item => {

                    const hour = new Date(item.hour).getHours();

                    const kwh_reading = item.kwh_reading;
                    const unit_generation = item.unit_generation

                    return {
                        hour: hour,
                        kwh_reading: kwh_reading,
                        unit_generation: unit_generation
                    };
                });
            }

            const transformedData = transformData(data);

            res.status(200).json(transformedData);

        } catch (error) {
            console.error('Error fetching power data:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    },

    reportData: async (req, res) => {
        try {
            const { fromDate, toDate } = req.body;

            const data = await Mains.sequelize.query(
                `WITH minutes AS (
                        -- Generate 5-minute timestamps within the given date range
                SELECT 
                    TO_CHAR(generated_minute + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI:00') AS minute
                    FROM generate_series(
                        (DATE_TRUNC('day', ${fromDate ? `'${fromDate}'` : 'NOW()'} AT TIME ZONE 'Asia/Kolkata') + INTERVAL '5 minutes') 
                        AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC',
                        ${toDate ? `'${toDate}'` : 'NOW()'} AT TIME ZONE 'UTC',
                        INTERVAL '5 minutes'
                    ) AS generated_minute
                ),
        
                power_data AS (
                -- Aggregate power data per 5-minute interval
                SELECT 
                    TO_CHAR(s."createdAt" + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:MI:00') AS minute,
                    MAX(s.unit_generated) AS unit_generated,  -- Get the maximum unit_generated per 5 minutes
                    MAX(s.kwh) AS kwh  -- Get the latest kWh_reading per 5 minutes
                    FROM main s
                    GROUP BY minute
                )
        
                SELECT 
                m.minute,
                    COALESCE(p.unit_generated, 0) AS unit_generation, -- Take the maximum per 5 minutes
                    CASE 
                WHEN (
                    (LAG(p.unit_generated) OVER (ORDER BY m.minute) = 0 AND p.unit_generated > 0) 
                    OR 
                    (LAG(p.unit_generated) OVER (ORDER BY m.minute) > 0 AND p.unit_generated = 0)
                )
                THEN 0
                ELSE COALESCE(ABS(p.kwh - LAG(p.kwh) OVER (ORDER BY m.minute)), 0)
                END AS kwh_reading
                FROM minutes m
                LEFT JOIN power_data p ON m.minute = p.minute
                ORDER BY m.minute;
        `,
                        { type: Mains.sequelize.QueryTypes.SELECT }
                    );
        
                    //console.log(data)
        
                    // Function to convert the data
                    function transformData(rawData) {
                        return rawData.map(item => {
                            const extractDate = (timestamp) => {
                                return timestamp.split(' ')[0]; // Splits by space and takes the date part
                            };
                            
                            const date = extractDate(item.minute);
                            const hour = new Date(item.minute).getHours();
                            const minute = new Date(item.minute).getMinutes().toString().padStart(2, '0');
                            const amPm = hour >= 12 ? 'PM' : 'AM';
                            const kwh_reading = item.kwh_reading;
                            const unit_generation = item.unit_generation
        
                            return {
                                date: date,
                                minute: `${hour}:${minute} ${amPm}`,
                                kwh_reading: kwh_reading,
                                unit_generation: unit_generation
                            };
                        });
                    }

            const transformedData = transformData(data);

            res.status(200).json(transformedData);

        } catch (error) {
            console.error('Error fetching power data:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}