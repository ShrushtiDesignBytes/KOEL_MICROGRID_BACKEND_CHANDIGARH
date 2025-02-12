var db = require('../../config/db');
const Solar = db.solar;
const sequelize = db.sequelize
const { Op, literal } = require('sequelize');

module.exports = {

    //get all solar
    getSolar: async (req, res) => {
        try {
            const result = await Solar.sequelize.query(`
               WITH hourly_avg AS (
                    SELECT 
                    DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,
                    AVG(
                            (("kW"->>'phase1')::FLOAT + 
                            ("kW"->>'phase2')::FLOAT + 
                            ("kW"->>'phase3')::FLOAT)
                        ) AS avg_kW_per_hour
                    FROM Solar
                    WHERE "createdAt" >= CURRENT_DATE
                    AND "createdAt" < CURRENT_DATE + INTERVAL '1 day'
                    GROUP BY hour
                )
                SELECT SUM(avg_kW_per_hour) AS avg_daily_total_generations FROM hourly_avg;

            `, {
                type: sequelize.QueryTypes.SELECT
            });

            const daily_generation = result[0].avg_daily_total_generations;

            const result_total = await Solar.sequelize.query(`
                WITH hourly_avg AS (
                    SELECT 
                    DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,  -- Truncate to the hour with IST adjustment
                    AVG(
                            (("kW"->>'phase1')::FLOAT + 
                            ("kW"->>'phase2')::FLOAT + 
                            ("kW"->>'phase3')::FLOAT)
                        ) AS avg_kW_per_hour  -- Calculate the average kW per hour
                    FROM 
                    solar
                    WHERE 
                        "createdAt" >= (SELECT MIN("createdAt") FROM Solar)  -- Start from the earliest available data
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

            const result_lastentry = await Solar.findOne({
                attributes: ['hours_operated'],
                where: {
                    createdAt: {
                        [Op.lte]: sequelize.literal('CURRENT_DATE'),
                    },
                    hours_operated: {
                        [Op.ne]: null,
                        [Op.ne]: ''
                    }
                },
                order: [['createdAt', 'DESC']],
                limit: 1,
            });

            const result_power = await Solar.sequelize.query(`
                WITH hourly_avg AS (
                    SELECT 
                    DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,
                    AVG(
                            (("kW"->>'phase1')::FLOAT + 
                            ("kW"->>'phase2')::FLOAT + 
                            ("kW"->>'phase3')::FLOAT)
                        ) AS avg_kW_per_hour
                    FROM Solar
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

            const result_power_before = await Solar.sequelize.query(`
                WITH hourly_avg AS (
                    SELECT 
                    DATE_TRUNC('hour', "createdAt" + INTERVAL '5 hours 30 minutes') AS hour,
                    AVG(
                            (("kW"->>'phase1')::FLOAT + 
                            ("kW"->>'phase2')::FLOAT + 
                            ("kW"->>'phase3')::FLOAT)
                        ) AS avg_kW_per_hour
                    FROM Solar
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

            const solar = await Solar.findOne({
                where: {
                   
                    operating_hours: {
                        [Op.ne]: null,
                        [Op.ne]: ''
                    },
                    hours_operated: {
                        [Op.ne]: null,
                        [Op.ne]: ''
                    }
                },
                order: [['createdAt', 'DESC']]
            });


            if (solar && result) {
                solar.dataValues.avg_daily_total_generation = Math.floor(daily_generation);
            }

            if (result_total) {
                solar.dataValues.avg_total_generation = Math.floor(total);
            }

            if (result_lastentry) {
                solar.dataValues.avg_hours_operated = result_lastentry.get('hours_operated');
            }

            if (result_power) {
                solar.dataValues.power_generated_yesterday = power_generation_yesterday;
            }

            if (result_power_before) {
                solar.dataValues.power_generated_before_yesterday = power_generation_before_yesterday;
            }

            await Solar.update(
                {
                    total_generation: Math.floor(total),
                    power_generated: power_generation_yesterday
                },
                { where: { id: solar.id } }
            );

            return res.status(200).send(
                [solar]
            );
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }
    },

    //add solar
    createSolar: async (req, res) => {
        const solarArray = req.body  

        try {
            const createdSolar = []

            for (const solardata of solarArray) {
                
                const { breaker_status, frequency, current, kVA, kW, maintainance_last_date, next_due, operating_hours, power_factor, voltagel, voltagen, hours_operated, kwh, unit_generated } = solardata;

                const { id, ...filteredData } = solardata;

                //console.log('data', filteredData)

                const localID =  await Solar.findOne({
                    where: {
                        localId: id
                    }
                });

                //console.log(localID)

                if (localID !== null) {
                    await Solar.update( filteredData ,
                        {
                            where: {
                                localId: id
                            }
                        });
                    
                    createdSolar.push('Updated Succesfully')
                } else {
                    //console.log(solardata.id)
                    try {
                        const result = await sequelize.query(
                            `CALL insert_unique_solar(
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
                        }
                        );
    
                        const solar = result[0][0].result_json;
    
                        const data = solar === null ? 'Already saved same data in database' : solar;
                        createdSolar.push(data);
    
                    } catch (innerError) {
                        createdSolar.push({ error: `Failed to process data for solar: ${innerError.message}` });
                    }
                }   
                
            }

            return res.status(200).send(createdSolar);
        } catch (error) {
            console.log(error)
            return res.status(500).json(
                error.message

            );
        }
    },

    //view solar by id
    viewSolar: async (req, res) => {
        const id = req.params.id
        try {
            const solar = await Solar.findByPk(id);
            return res.status(200).send(
                solar
            );
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }

    },

    //delete solar by id
    deleteSolar: async (req, res) => {
        const id = req.params.id;
        try {
            const solar = await Solar.destroy({ where: { id } });
            return res.status(200).send({
                message: 'Deleted Successfully'
            });
        } catch (error) {
            return res.status(400).send(
                error.message
            );
        }
    },

    //solar update by id
    updateSolar: async (req, res) => {
        const { breaker_status, frequency, current, kVA, kW, maintainance_last_date, next_due, notification_alarms, operating_hours, power_factor, shutdown, total_generation, total_saving, total_utilisation, utilisation, voltagel, voltagen, hours_operated, power_generated, daily_generation } = req.body
        const id = req.params.id;
        try {
            const solar = await Solar.update({
                breaker_status, frequency, current, kVA, kW, maintainance_last_date, next_due, notification_alarms, operating_hours, power_factor, shutdown, total_generation, total_saving, total_utilisation, utilisation, voltagel, voltagen, hours_operated, power_generated, daily_generation
            },
                {
                    where: {
                        id
                    }
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
            
            const data = await Solar.sequelize.query(
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
                    LEFT JOIN solar s ON 
                        TO_CHAR(s."createdAt" + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD HH24:00:00') = h.hour
                    GROUP BY h.hour
                    ORDER BY h.hour;
              `,
                { type: Solar.sequelize.QueryTypes.SELECT }
            );

            //console.log(data)

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
    }
}