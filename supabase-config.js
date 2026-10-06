// Public project configuration only. Never put a secret/service_role key here.
// Existing ANTOVIUM project. Schema and owner-based RLS inspected in Supabase.
export const SUPABASE_CONFIG = {
  url:'https://hmdjcxpogdrveddznedx.supabase.co',
  publishableKey:'sb_publishable_6mDpQ-hKERSZngTl8Ki5LQ_JkHGbOd4',
  statusValues:{ active:'planned',done:'done' },
  statusReadValues:{ planned:'active',in_progress:'active',waiting:'active',done:'done' },
  priorityValues:{ normal:'normal',medium:'high',high:'critical' },
  priorityReadValues:{ low:'normal',normal:'normal',high:'medium',critical:'high' },
  deadlineTimeZone:'Europe/Saratov',
  schemaVerified:true
};
