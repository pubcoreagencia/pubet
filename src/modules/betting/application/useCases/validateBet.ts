import { Bet } from '../../domain/entities/Bet';
import { Event } from '../../domain/entities/Event';
import { User } from '../../domain/entities/User';
import { BetRepository } from '../../domain/repositories/BetRepository';
import { EventRepository } from '../../domain/repositories/EventRepository';
import { UserRepository } from '../../domain/repositories/UserRepository';

export class BetValidator {
  constructor(
    private betRepository: BetRepository,
    private eventRepository: EventRepository,
    private userRepository: UserRepository
  ) {}

  async validate(bet: Bet, userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Validate user exists and has sufficient balance
    const user = await this.userRepository.findById(userId);
    if (!user) {
      errors.push('User not found');
      return { valid: false, errors };
    }

    if (user.balance < bet.amount) {
      errors.push('Insufficient balance');
    }

    // Validate event exists and is active
    const event = await this.eventRepository.findById(bet.eventId);
    if (!event) {
      errors.push('Event not found');
      return { valid: false, errors };
    }

    if (event.status !== 'active') {
      errors.push('Event is not active');
    }

    // Validate market exists in event
    const marketExists = event.markets.some(m => m.id === bet.marketId);
    if (!marketExists) {
      errors.push('Invalid market selection');
    }

    // Validate bet amount meets minimum requirement
    if (bet.amount < event.minBetAmount) {
      errors.push(`Minimum bet amount is ${event.minBetAmount}`);
    }

    // Validate odds are within acceptable range
    if (bet.odds < 1.0 || bet.odds > 1000.0) {
      errors.push('Odds must be between 1.0 and 1000.0');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

// Integration with placeBet use case
import { placeBet } from './placeBet';

export async function placeBetWithValidation(
  bet: Bet,
  userId: string,
  betRepository: BetRepository,
  eventRepository: EventRepository,
  userRepository: UserRepository
): Promise<{ success: boolean; betId?: string; errors?: string[] }> {
  const validator = new BetValidator(betRepository, eventRepository, userRepository);
  const validation = await validator.validate(bet, userId);

  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  return placeBet(bet, userId, betRepository);
}