-- Whether the user found each lead useful, rated from the thumbs up or down next to it, with an
-- optional note. Replaces the per-lead "report an issue" action, which filed lead feedback as an
-- error report.
--
-- Stored on the lead, so it is the user's own data like responded_at: they set, change, and clear
-- it through the backend acting as themselves. A search that finds the lead again keeps the rating,
-- since saving a search only writes the columns it searched for.

alter table public.search_results
  add column useful        boolean,
  add column feedback_note text check (char_length(feedback_note) <= 2000),
  add column rated_at      timestamptz;

comment on column public.search_results.useful        is 'The user''s answer to "Is this lead useful?": true, false, or null when not rated';
comment on column public.search_results.feedback_note is 'Anything the user wrote with the rating';
comment on column public.search_results.rated_at      is 'When the user last rated the lead';

-- A note and a time only exist with a rating; clearing the rating clears them.
alter table public.search_results add constraint search_results_feedback_needs_rating
  check (useful is not null or (feedback_note is null and rated_at is null));
