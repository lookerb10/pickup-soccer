# Pickup Soccer

A sign-up, roster, and scheduling site for a casual pickup soccer group. Static HTML/CSS/JS backed by Supabase — no build step, no framework.

**Live site:** https://lookerb10.github.io/pickup-soccer/

## How it's structured

- `index.html` — page markup for all tabs (Home, Event, Join, Roster, Vote, Board, Ideas, Organizer)
- `styles.css` — all styling
- `app.js` — all behavior: talks to Supabase directly via `fetch()` against its REST API (no client library, no build step)

There is no build/bundle step. GitHub Pages serves these three files as-is. Pushing to `main` redeploys automatically within a minute or two.

## Running locally

Any static file server works, e.g.:

```
python3 -m http.server 8000
```

then open `http://localhost:8000/index.html`. Since it's all client-side and talks directly to the shared production Supabase project, there's no separate "local backend" to run — you're working against the same live data as the deployed site. Be careful with test data for that reason (see below).

## Tabs / features

- **Event** — announcement banner (shown on every tab) and a dedicated page for a one-off featured event, with live "In / Maybe / Can't make it" RSVPs backed by the `event_rsvps` table.
- **Join** — roster sign-up (name, contact info, availability, preferences). No login. Blocks joining under an exact duplicate name (case-insensitive, whitespace-trimmed) already on the roster, so e.g. two people can't both be plain "Daniel" — "Daniel" and "Daniel L" are fine as distinct people. Enforced both client-side (checked before insert) and at the database level (`entries_name_unique_idx`, a unique index on `lower(trim(name))`), so it holds even under a race (double-click, two open tabs, etc.).
- **Roster** — public list of everyone who joined (private-visibility entries hide contact details from everyone but the organizer).
- **Vote** — anyone can propose a match (date + optional location note + whether they're open to a full game, a practice, or either). Others vote on which time blocks work and can add a preferred location. Time slots close automatically once they're in the past. Voting again under the same name replaces your prior vote — you'll get a confirm prompt if that name already has a vote recorded, to catch accidental overwrites. A match is labeled 🎮 Game once 6+ people have voted (3v3 minimum); otherwise it shows as ⚽ Practice, unless the proposer specifically restricted it to one or the other.
- **Board** — free-form message posting, visible to everyone.
- **Ideas** — suggestions with threaded comments.
- **Organizer** — gated by a shared passphrase (`settings.organizer_pin`), not a real login. Lets the organizer send board-post + email updates, edit their public contact info, and delete roster entries / board messages / suggestions / matches / individual votes.

## Supabase

Project ref: `qcxwuajdclgxfbvvtbsg`. The anon key is embedded directly in `app.js` — this is expected and safe for Supabase's anon key (it's meant to be public; access control lives in Row Level Security policies, not key secrecy).

Current tables:

| Table | Purpose | Key columns |
|---|---|---|
| `entries` | Roster sign-ups | `name`, `phone`, `email`, `frequency`, `experience`, `intensity`, `position`, `age`, `notes`, `availability` (text[]), `visibility` (`public`/`private`), `jersey_number`, `submitted_at` |
| `messages` | Board posts | `author`, `message`, `created_at` |
| `suggestions` | Ideas tab entries | `author`, `category`, `suggestion`, `created_at` |
| `comments` | Replies to suggestions | `suggestion_id`, `author`, `comment`, `created_at` |
| `matches` | Proposed match dates | `creator_name`, `match_date`, `note`, `wants_game`, `wants_practice`, `created_at` |
| `poll_votes` | Per-match availability votes | `match_id`, `name`, `slot` (e.g. `"8-10"`), `location`, `created_at` |
| `settings` | Key/value config | `organizer_pin`, `organizer_contact` (JSON string) |
| `event_rsvps` | RSVPs for the featured Event tab | `name`, `status` (`in`/`maybe`/`out`), `guests` (extra headcount), `created_at` |

All tables currently have permissive Row Level Security policies (open read/write via the anon key) — there's no per-user auth. An earlier iteration explored real Supabase Auth accounts for editing votes but it was reverted in favor of the simpler name-based + confirm-popup approach described above, so there's no login system to reason about.

### Recreating the schema elsewhere

If you ever need to stand up a fresh Supabase project (e.g. a staging environment), run something like:

```sql
create table entries (
  id uuid primary key default gen_random_uuid(),
  jersey_number int generated always as identity,
  name text not null,
  phone text, email text,
  frequency text, experience text, intensity text, position text, age text,
  notes text,
  availability text[],
  visibility text not null default 'public',
  submitted_at timestamptz not null default now()
);
create unique index entries_name_unique_idx on entries (lower(trim(name)));

create table messages (
  id uuid primary key default gen_random_uuid(),
  author text not null, message text not null,
  created_at timestamptz not null default now()
);

create table suggestions (
  id uuid primary key default gen_random_uuid(),
  author text, category text not null, suggestion text not null,
  created_at timestamptz not null default now()
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid references suggestions(id) on delete cascade,
  author text, comment text not null,
  created_at timestamptz not null default now()
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  creator_name text not null,
  match_date date not null,
  note text,
  wants_game boolean not null default true,
  wants_practice boolean not null default true,
  created_at timestamptz not null default now()
);

create table poll_votes (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references matches(id) on delete cascade,
  name text not null,
  slot text not null,
  location text,
  created_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value text
);

create table event_rsvps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null,
  guests int not null default 0,
  created_at timestamptz not null default now()
);

-- open access via the anon key for every table above, e.g.:
alter table entries enable row level security;
create policy "entries anon all" on entries for all using (true) with check (true);
-- ...repeat the enable + open policy pair for each table
```

Then update `SUPABASE_URL` and `SUPABASE_ANON_KEY` near the top of `app.js`.

## Working with a collaborator

- No build step means diffs in `app.js`/`styles.css`/`index.html` are plain text diffs — review as normal.
- Everything runs against one shared production Supabase project (there's no staging/dev database). When testing something that writes data, prefix test names obviously (e.g. `QA ...`) and clean up afterward via the Supabase dashboard or REST API.
- The organizer passphrase is a UI gate, not real access control — anyone with the anon key (i.e. anyone who's opened the page) already has the same database access. Don't rely on it as a security boundary.
