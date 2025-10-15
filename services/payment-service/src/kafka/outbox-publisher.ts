import { OutboxRepository } from '../repositories/OutboxRepository';
import { kafkaProducer } from './producer';
import { logger } from '../utils/logger';

export class OutboxPublisher {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(private outboxRepo: OutboxRepository, private pollIntervalMs: number = 1000) {}

  start(): void {
    if (this.isRunning) {
      logger.warn('Outbox publisher already running');
      return;
    }

    this.isRunning = true;
    logger.info({ pollIntervalMs: this.pollIntervalMs }, 'Starting outbox publisher');

    this.intervalId = setInterval(async () => {
      await this.publishPendingMessages();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Outbox publisher stopped');
  }

  private async publishPendingMessages(): Promise<void> {
    try {
      const messages = await this.outboxRepo.findPending(100);

      if (messages.length === 0) {
        return;
      }

      logger.debug({ count: messages.length }, 'Publishing outbox messages');

      for (const message of messages) {
        try {
          await kafkaProducer.send({
            topic: message.topic,
            messages: [
              {
                key: message.key,
                value: JSON.stringify(message.payload),
                headers: {
                  eventId: message.payload.eventId,
                  correlationId: message.payload.correlationId,
                },
              },
            ],
          });

          await this.outboxRepo.markDelivered(message.id);
          logger.debug({ messageId: message.id, topic: message.topic }, 'Outbox message published');
        } catch (err) {
          logger.error({ err, messageId: message.id }, 'Failed to publish outbox message');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in outbox publisher');
    }
  }
}
