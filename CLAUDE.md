# KitabDostu backend — layihə konteksti

Bu fayl bu qovluqda hər Claude Code sessiyası başlayanda avtomatik oxunur.
Məqsədi: heç bir izahat verilmədən layihənin tam vəziyyətini bilmək.

## Nə layihədir

**KitabDostu** — Azərbaycan üçün kitabsevərlər sosial şəbəkəsi + bazar yeri.
Holberton School bitirmə layihəsi (məzun işi), GRC layihələri ilə heç bir
əlaqəsi yoxdur. Bu repo **backend**-dir (API + baza).

| | Yer | Repo |
|---|---|---|
| Backend (bu qovluq) | `C:\Users\User\kitabdostu-backend` | `rasulinho08/holbertonfinalproject-backend` |
| **Frontend** | `C:\Users\User\holbertonfinalproject` | `rasulinho08/holbertonfinalproject` |

Frontend detalları (Cloudflare, EAS, iOS/Android) üçün o repodakı
`CLAUDE.md`-ə bax.

## Texnologiya

Express + Prisma + PostgreSQL, TypeScript.

## Deploy

**Canlı ünvan:** https://holbertonfinalproject-backend.onrender.com
(API kökü: `/api/v1`, sağlamlıq: `/health`)

Render (Docker, [render.yaml](render.yaml)) — `main`-ə push avtomatik deploy
edir. Baza — **Neon** Postgres (pulsuz, müddətsiz). Render-in öz pulsuz
Postgres-i **qəsdən istifadə olunmur** — 30 gündə silinir.

Pulsuz Render 15 dəqiqə trafiksiz qalanda yatır, növbəti sorğu ~30-50 saniyə
gözləyir.

Ətraflı addım-addım təlimat: [DEPLOY.md](DEPLOY.md).

**Tələ — CORS:** `CORS_ORIGINS` env dəyişəni Render-də frontend origin-ini
dəqiq daşımalıdır (`https://holbertonfinalproject0.mamishovrasul028.workers.dev`,
Cloudflare Worker-in ünvanı). [src/app.ts](src/app.ts) rədd edən origin-i
`Error` ilə qaytarır — brauzerdə **500** kimi görünür, CORS mesajı kimi yox.
Backend öz log-larında `CORS: origin refused` yazır, rədd edilən origin adı
ilə birgə.

## Lokal işə salma

```bash
npm run db:up        # docker-compose ilə lokal Postgres, port 5544
npm run migrate       # prisma migrate dev
npm run seed           # 1000 kitablıq kataloq + demo hesablar
npm run dev             # tsx watch, http://localhost:4000/api/v1
```

`.env`-dəki `DATABASE_URL`: `postgresql://kitabdostu:kitabdostu@localhost:5544/kitabdostu`.
Docker Desktop işlək olmalıdır (bu sessiyada işləmirdi, aktivləşdirmək lazım
ola bilər).

**Demo hesab:** `leyla@kitabdostu.az` / `password123` (həmçinin `publisher@`,
`admin@` — həm lokal seed-də, həm production Neon bazasında eyni).

## Arxitektura — nailiyyət/statistika sistemi

Bu, ən çox səhv düşən hissədir. Profil statistikası (`booksRead`, `pagesRead`),
illik hədəf ("8/24" halqası) və nişanlar (badges) **hamısı** `ShelfEntry` və
`ReadingSession` cədvəllərindən oxunur — [src/modules/users/service.ts](src/modules/users/service.ts)
(`computeStats`), [src/modules/gamification/badges.ts](src/modules/gamification/badges.ts).

Yəni oxumanı qeyd edən **hər yeni yol** (reading session, shelf progress,
buddy-read progress və s.) bu iki cədvələ də toxunmalıdır, əks halda o
fəaliyyət heç yerdə görünmür. Nümunə: `shelves/service.ts`-dəki
`updateProgress` və `sessions/service.ts`-dəki `logSession` bunu edir;
`buddy/service.ts`-dəki `updateBuddyProgress` əvvəllər etmirdi (2026-08-18-də
düzəldildi, aşağı bax).

Paylaşılan köməkçilər `shelves/service.ts`-dən ixrac olunub, təkrar
yazmaqdansa import et:
- `defaultShelvesByStatus(userId)` — 4 default rəfin id-lərini qaytarır,
  yoxdursa yaradır.
- `checkGoalReached(userId)` — illik hədəf bitəndə bildiriş göndərir.

## Son iş (2026-08-18) — QA fix

Amin-in QA hesabatındakı defekt: "Birlikdə oxu" (buddy-read) vasitəsilə
oxunan səhifələr/kitablar nailiyyətlərə sayılmırdı. Səbəb: `updateBuddyProgress`
yalnız `BuddyReadMember.progressPage`-i yazırdı, `ShelfEntry`/`ReadingSession`-a
heç toxunmurdu — iki tamam ayrı sayğac idi.

Düzəliş: [src/modules/buddy/service.ts](src/modules/buddy/service.ts)-dəki
`updateBuddyProgress` indi `shelves/service.ts`-dəki `updateProgress`-in eyni
məntiqini işlədir — rəf yazısını yaradır/irəlilədir, status keçidlərini
(`want_to_read`→`reading`→`read`) tətbiq edir, `ReadingSession` sətri əlavə
edir, hədəf yoxlaması və badge yenidən-qiymətləndirməsi çağırır.

Canlı backend-də `leyla` hesabı ilə test edilib: "Müharibə və sülh" kitabını
buddy-read vasitəsilə bitirəndə rəf statusu `null`→`read`, `booksRead` 14→15,
`pagesRead` 4084→5309, illik hədəf 9/24→10/24, `reading_marathon` nişanı elə
o anda qazanıldı. Tam təsdiqlənib.

## Test

Vahid test faylı yoxdur (vitest qurulub, amma boşdur). `npm run smoke` (auth +
kataloq) və `npm run smoke:full` (bütün modullar) canlı/lokal API-yə qarşı
işləyir — TypeScript yoxdur, HTTP cavabları yoxlayır.

`npm run lint` işləmir — `eslint.config.js` mövcud deyil, əvvəldən belədir
(bu sessiyanın işi ilə əlaqəsi yoxdur).
