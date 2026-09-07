import { z } from "zod";

export interface PlaceBetInput {
  betId: string;
  userId: string;
  eventId: string;
  selection: string;
  amount: number;
  currency: string;
  timestamp: number;
}

export const placeBetSchema = z.object({
  betId: z.string().uuid(),
  userId: z.string().uuid(),
  eventId: z.string().uuid(),
  selection: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3).uppercase(),
  timestamp: z.number().int().positive(),
});

export type PlaceBetSchemaInput = z.infer<typeof placeBetSchema>;

export class PlaceBetUseCase {
  async execute(input: PlaceBetSchemaInput) {
    const validated = placeBetSchema.parse(input);

    // Simulated business logic: validate odds, balance, limits
    const oddsMultiplier = 2.5; // would come from odds service
    const potentialPayout = validated.amount * oddsMultiplier;

    return {
      betId: validated.betId,
      status: "accepted",
      potentialPayout,
    };
  }
}

export default PlaceBetUseCase;