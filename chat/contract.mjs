import { z } from 'zod';

const line = z.string().trim().min(1).max(4000);
export const specSchema = z.object({
  title: line.max(60), summary: line,
  acceptance: z.array(line).min(1).max(20),
  unchanged: z.array(line).max(20),
  check: line, journey: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(80),
  reviewFocus: line,
}).strict();

export const draftSchema = z.object({
  spec: specSchema,
  findings: z.array(z.object({ path: line.max(500), note: line })).max(30),
}).strict();

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
