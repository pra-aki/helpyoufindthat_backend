-- One line per lead, shown in the results list in place of the title and the two descriptions:
-- what the author wants, said in terms of what the product does. Leads stored before this have
-- none; the app falls back to the title for those.
alter table public.search_results add column gist text;

comment on column public.search_results.gist is 'One line: what the author wants, in terms of what the product does; null for leads stored before it existed';
