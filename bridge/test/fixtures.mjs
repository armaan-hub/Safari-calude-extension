// Fictional test fixtures only. No real person, employer, salary or contact.

export const TEST_PROFILE = {
  name: 'Test User',
  salary: {
    expected_uae_minimum_monthly_aed: 10000,
    expected_germany_annual_eur_gross: '50000-60000',
  },
  search: {
    target_roles: [
      'Power BI developer',
      'BI analyst / BI developer',
      'data analyst',
      'financial analyst',
      'MIS analyst',
      'reporting analyst',
    ],
    excluded_roles: ['accounting', 'audit'],
    locations: {
      uae: ['Dubai', 'Sharjah', 'Abu Dhabi'],
      germany: 'English-speaking roles only',
    },
  },
  skills: ['DAX', 'SQL'],
};

export function rawJob(overrides = {}) {
  return {
    job_id: '3912345678',
    title: 'Power BI Developer',
    company: 'Example Co',
    location: 'Dubai, United Arab Emirates',
    region: 'uae',
    posted_text: '3 hours ago',
    applicants_text: '7 applicants',
    url: 'https://www.linkedin.com/jobs/view/3912345678/',
    fit_score: 80,
    fit_reason: 'Title and DAX skills match',
    pay_text: null,
    permit_required: false,
    sponsorship_mention: false,
    date_filter_confirmed: true,
    location_confirmed: true,
    ...overrides,
  };
}
