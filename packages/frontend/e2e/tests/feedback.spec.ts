import { test, expect } from '../fixtures';

test('feedback form submits and shows success screen', async ({ page }) => {
  // Hard: page must load
  await page.goto('/');
  await expect(page).toHaveTitle(/911realtime/i);

  // Open the Feedback app — the desktop icon is a role="button" named "Feedback".
  // Double-click dispatches onDoubleClick → launchIcon → opens the app window.
  await page.getByRole('button', { name: 'Feedback' }).dblclick();
  // Wait for the form to be visible before filling — Playwright auto-waits but an
  // explicit wait makes the failure message clearer if the window fails to open.
  // Use exact: true because "GitHub username (optional)" contains the substring "name",
  // which causes getByLabel('Name') to match two inputs without the flag.
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();

  // Intercept the feedback POST — use **/feedback to match the absolute URL
  // (useFeedback builds: `${VITE_FEEDBACK_URL}/feedback` — not a same-origin path)
  await page.route('**/feedback', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ issueUrl: 'https://github.com/keeping-history/rt911/issues/999' }),
    });
  });

  // Fill the form — locators use label associations (htmlFor/id pairs)
  await page.getByLabel('Name', { exact: true }).fill('Test User');
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByLabel('Title').fill('E2E test submission');
  await page.getByLabel('Description').fill('This is a test feedback submission from Playwright.');

  // Submit button uses ClassicyButton (onClick) — .click() triggers the handler correctly.
  await page.getByRole('button', { name: /send feedback/i }).click();

  // Soft assertions: collect all UI failures, none abort the test
  await expect.soft(page.getByText(/thanks for your feedback/i)).toBeVisible();
  await expect.soft(page.getByRole('link', { name: /view your github issue/i })).toBeVisible();
  await expect.soft(page.getByRole('button', { name: /send another feedback/i })).toBeVisible();
});
