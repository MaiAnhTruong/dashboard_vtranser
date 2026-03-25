window.VT_PRE_DB_CONFIG = {
  // true: use this file for dates before DB_FROM_DATE.
  ENABLED: true,

  // Session usage card (pie chart).
  LIVE_SESSION_TOTAL: 2,
  LIVE_SESSION_ACTIVE: 1,

  // First day shown on timeline. Days without data are rendered as 0 users.
  DISPLAY_START_DATE: "2026-02-11",

  // From this date (inclusive), dashboard reads directly from Supabase.
  DB_FROM_DATE: "2026-03-13",

  // Editable daily registrations before DB_FROM_DATE.
  DAILY_NEW_USERS: {
    "2026-02-23": 2,
    "2026-02-24": 4,
    "2026-02-25": 6,
    "2026-02-26": 5,
    "2026-02-27": 7,
    "2026-02-28": 6,
    "2026-03-01": 8,
    "2026-03-02": 5,
    "2026-03-03": 9,
    "2026-03-04": 68,
    "2026-03-05": 25,
    "2026-03-06": 29,
    "2026-03-07": 20,
    "2026-03-08": 33,
    "2026-03-09": 27,
    "2026-03-10": 30,
    "2026-03-11": 24,
    "2026-03-12": 38,
  },

  // Editable frequent users by day (bar chart).
  // Frequent user = account with registration lifetime > 1 day.
  DAILY_FREQUENT_USERS: {
    "2026-02-23": 0,
    "2026-02-24": 1,
    "2026-02-25": 1,
    "2026-02-26": 1,
    "2026-02-27": 2,
    "2026-02-28": 2,
    "2026-03-01": 3,
    "2026-03-02": 3,
    "2026-03-03": 4,
    "2026-03-04": 4,
    "2026-03-05": 5,
    "2026-03-06": 6,
    "2026-03-07": 6,
    "2026-03-08": 7,
    "2026-03-09": 7,
    "2026-03-10": 8,
    "2026-03-11": 8,
    "2026-03-12": 9,
  },
};
