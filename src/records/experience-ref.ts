import { z } from "zod";

export const experienceRefSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExperienceRef = z.infer<typeof experienceRefSchema>;
