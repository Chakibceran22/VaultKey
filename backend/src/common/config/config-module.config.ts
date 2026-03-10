import * as Joi from 'joi';

export const configSchema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    PORT: Joi.number().default(3000),
    JWT_SECRET: Joi.string().required(),
    DATABASE_URL: Joi.string().required(),
    JWT_EXPIRES_IN: Joi.string().default('24h'),
    

})