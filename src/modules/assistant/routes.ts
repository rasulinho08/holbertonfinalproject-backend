import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, userId } from '../../middleware/auth.js';
import { assistantLimiter } from '../../middleware/rateLimit.js';
import { ok } from '../../lib/envelope.js';
import { chat, isAssistantAvailable } from './service.js';

export const assistantRouter: Router = Router();

/** Lets the app show or hide the assistant without sending a message. */
assistantRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    ok(res, { available: isAssistantAvailable() });
  }),
);

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(30)
    // The model answers the last user turn, and a conversation starts with one.
    .refine((m) => m[0]?.role === 'user' && m[m.length - 1]?.role === 'user', {
      message: 'The conversation must start and end with a user message',
    }),
});

assistantRouter.post(
  '/chat',
  requireAuth,
  assistantLimiter,
  validate(chatSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: userId(req) }, select: { name: true } });
    try {
      ok(res, await chat(req.body.messages, user?.name ?? 'Oxucu'));
    } catch {
      throw new ApiError('SERVER_ERROR', 'The assistant could not answer right now. Please try again.');
    }
  }),
);
