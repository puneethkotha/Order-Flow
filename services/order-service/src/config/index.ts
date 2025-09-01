import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://orderflow:orderflow123@localhost:5432/orderdb',
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || 'order-service',
    groupId: process.env.KAFKA_GROUP_ID || 'order-service-group',
  },
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
};
