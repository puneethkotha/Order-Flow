import { Kafka, Producer, ProducerRecord } from 'kafkajs';
import { config } from '../config';
import { logger } from '../utils/logger';

class KafkaProducer {
  private kafka: Kafka;
  private producer: Producer;
  private connected: boolean = false;

  constructor() {
    this.kafka = new Kafka({
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      retry: {
        retries: 5,
        initialRetryTime: 300,
        maxRetryTime: 30000,
      },
    });

    // Idempotent producer: exactly-once-per-partition dedup without a
    // transactionalId (the outbox publisher uses plain sends, not Kafka
    // transactions, so a transactionalId here would be an error at send time).
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.producer.connect();
      this.connected = true;
      logger.info('Kafka producer connected');
    } catch (err) {
      logger.error({ err }, 'Failed to connect Kafka producer');
      throw err;
    }
  }

  async send(record: ProducerRecord): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      await this.producer.send(record);
      logger.debug({ topic: record.topic, messages: record.messages.length }, 'Messages sent to Kafka');
    } catch (err) {
      logger.error({ err, topic: record.topic }, 'Failed to send message to Kafka');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.producer.disconnect();
      this.connected = false;
      logger.info('Kafka producer disconnected');
    } catch (err) {
      logger.error({ err }, 'Failed to disconnect Kafka producer');
    }
  }
}

export const kafkaProducer = new KafkaProducer();
