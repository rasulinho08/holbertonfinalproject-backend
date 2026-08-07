import { Router } from 'express';
import { authRouter } from './auth/routes.js';
import { authorsRouter } from './authors/routes.js';
import { booksRouter, genresRouter, searchRouter } from './books/routes.js';
import { bookShelfRouter, shelvesRouter } from './shelves/routes.js';
import { feedRouter, usersRouter } from './users/routes.js';
import { bookSessionsRouter, sessionsRouter } from './sessions/routes.js';
import { bookListsRouter, listsRouter } from './lists/routes.js';
import { bookSocialRouter, quotesRouter, reviewsRouter } from './social/routes.js';
import {
  cartRouter,
  giftCardsRouter,
  ordersRouter,
  paymentsRouter,
  walletRouter,
} from './commerce/routes.js';
import {
  badgesRouter,
  leaderboardRouter,
  notificationsRouter,
  streakRouter,
  userBadgesRouter,
} from './gamification/routes.js';
import { buddyRouter } from './buddy/routes.js';
import { publisherRouter } from './publisher/routes.js';
import { adminRouter, reportsRouter } from './admin/routes.js';
import { ocrRouter, uploadsRouter } from './media/routes.js';

/**
 * The API router.
 *
 * Every module owns three files — `routes.ts` (wiring), `service.ts` (logic),
 * `schemas.ts` (Zod) — and is mounted here. Paths live inside each module's
 * router so this file stays a table of contents rather than a second place
 * route strings have to be kept in sync.
 *
 * Several resources hang off `/books/:id` — shelf state, progress, sessions,
 * reviews, quotes, lists. Rather than pulling all of that into the books
 * module, each owner exposes a small router mounted at the same prefix. Express
 * tries them in order, so `/books/:id` in `booksRouter` must be registered
 * last: a router that matches it first would swallow `/books/:id/reviews`.
 */
export const apiRouter: Router = Router();

apiRouter.get('/', (_req, res) => {
  res.json({
    data: {
      name: 'KitabDostu API',
      version: 'v1',
      docs: 'See backend-guide/ENDPOINTS.md in the frontend repository',
    },
  });
});

apiRouter.use('/auth', authRouter);

// Sub-resources of a book, before the catalogue's own `/:id` routes.
apiRouter.use('/books', bookShelfRouter);
apiRouter.use('/books', bookSessionsRouter);
apiRouter.use('/books', bookListsRouter);
apiRouter.use('/books', bookSocialRouter);
apiRouter.use('/books', booksRouter);

apiRouter.use('/authors', authorsRouter);
apiRouter.use('/genres', genresRouter);
apiRouter.use('/search', searchRouter);

apiRouter.use('/shelves', shelvesRouter);
apiRouter.use('/reading-sessions', sessionsRouter);
apiRouter.use('/lists', listsRouter);

// `/users/:username/badges` lives in the gamification module, so it is mounted
// before the users router, whose `/:username` would otherwise match it.
apiRouter.use('/users', userBadgesRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/feed', feedRouter);

apiRouter.use('/reviews', reviewsRouter);
apiRouter.use('/quotes', quotesRouter);

apiRouter.use('/cart', cartRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/wallet', walletRouter);
apiRouter.use('/gift-cards', giftCardsRouter);

apiRouter.use('/badges', badgesRouter);
apiRouter.use('/leaderboard', leaderboardRouter);
apiRouter.use('/streak', streakRouter);
apiRouter.use('/notifications', notificationsRouter);

apiRouter.use('/buddy-reads', buddyRouter);
apiRouter.use('/publisher', publisherRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/admin', adminRouter);

apiRouter.use('/uploads', uploadsRouter);
apiRouter.use('/ocr', ocrRouter);
