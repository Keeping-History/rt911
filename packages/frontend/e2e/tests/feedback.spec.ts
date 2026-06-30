import { test, expect } from '../fixtures';

test('feedback form submits and shows success screen', async ({ page }) => {
  // Hard: page must load
  await page.goto('/');
  await expect(page).toHaveTitle(/911realtime/i);

  // TODO: Replace this comment with the codegen-captured steps to open the Feedback window.
  // Run: pnpm --filter @rt911/frontend run codegen http://localhost:5173
  // Then click whatever opens the Feedback app in the Classicy desktop and copy the generated steps here.

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
  await page.getByLabel('Name').fill('Test User');
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByLabel('Title').fill('E2E test submission');
  await page.getByLabel('Description').fill('This is a test feedback submission from Playwright.');

  // Submit button uses onMouseUp — .click() will not trigger the handler
  await page.getByRole('button', { name: /send feedback/i }).dispatchEvent('mouseup');

  // Soft assertions: collect all UI failures, none abort the test
  await expect.soft(page.getByText(/thanks for your feedback/i)).toBeVisible();
  await expect.soft(page.getByRole('link', { name: /view your github issue/i })).toBeVisible();
  await expect.soft(page.getByRole('button', { name: /send another feedback/i })).toBeVisible();
});
