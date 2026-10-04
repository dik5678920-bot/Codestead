import { z } from "zod";
export const profileSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bio: z.string().trim().max(280),
  analogyFrequency: z.enum(["helpful", "frequent", "neutral"]),
  cohortVisibility: z.enum(["hidden", "alias", "selected"]),
  profileVersion: z.number().int().min(0),
  cohortVersion: z.number().int().min(0),
  requestId: z.uuid(),
}).strict();
export type ProfileSettingsInput = z.infer<typeof profileSettingsSchema>;
export type LearningProfile = Omit<ProfileSettingsInput, "requestId"> & { cohortAlias: string | null; cohortConsent: boolean };
export class ProfileSettingsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
