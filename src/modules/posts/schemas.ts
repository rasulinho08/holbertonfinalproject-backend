import { z } from 'zod';

/**
 * Publication validation schemas.
 *
 * Content length is capped well short of the TEXT column's 1GB limit: a reader
 * never needs to scroll through War and Peace on their phone in a single
 * publication, and keeping it honest prevents someone dumping a book into the
 * table and blowing out storage.
 */

export const publicationCreateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters'),
  content: z
    .string()
    .trim()
    .min(1, 'Content is required')
    .max(200_000, 'Content must be at most 200,000 characters'),
  coverUrl: z
    .string()
    .trim()
    .max(2000, 'Cover URL must be at most 2000 characters')
    .nullish(),
  recommendedBooks: z
    .array(
      z.object({
        bookId: z.string().uuid('bookId must be a valid id'),
        note: z.string().trim().max(500, 'Note must be at most 500 characters').optional().nullable(),
      }),
    )
    .max(50, 'At most 50 books can be recommended')
    .optional(),
});

export const publicationUpdateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters')
    .optional(),
  content: z
    .string()
    .trim()
    .min(1, 'Content is required')
    .max(200_000, 'Content must be at most 200,000 characters')
    .optional(),
  coverUrl: z
    .string()
    .trim()
    .max(2000, 'Cover URL must be at most 2000 characters')
    .nullish(),
  recommendedBooks: z
    .array(
      z.object({
        bookId: z.string().uuid('bookId must be a valid id'),
        note: z.string().trim().max(500, 'Note must be at most 500 characters').optional().nullable(),
      }),
    )
    .max(50, 'At most 50 books can be recommended')
    .optional(),
});

export type PublicationCreateInput = z.infer<typeof publicationCreateSchema>;
export type PublicationUpdateInput = z.infer<typeof publicationUpdateSchema>;
