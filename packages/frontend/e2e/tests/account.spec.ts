import { expect, test } from "../fixtures";

// Account app sign-in flow: boots anonymous (GET /users/me -> 401), opens via
// its desktop icon, fills the email/password ClassicyInputs, submits, and
// lands on the signed-in view. All Directus calls are intercepted — no live
// API dependency. Route-interception ordering matters here: /users/me is
// registered once and reads a flag that /auth/login flips, rather than
// re-routing mid-test (Playwright keeps the first matching handler active
// for the page's lifetime).
test("email sign-in reaches the signed-in view", async ({ page }) => {
	let signedIn = false;

	await page.route("**/users/me**", (route) => {
		if (signedIn) {
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					data: {
						id: "e2e-user",
						email: "teacher@example.com",
						first_name: "Terry",
						last_name: "Teacher",
					},
				}),
			});
		}
		return route.fulfill({
			status: 401,
			contentType: "application/json",
			body: JSON.stringify({ errors: [{ message: "Not authenticated" }] }),
		});
	});

	await page.route("**/auth/login", (route) => {
		signedIn = true;
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ data: {} }),
		});
	});

	await page.goto("/");
	await expect(page.locator(".classicyDesktop")).toBeVisible();

	await page.getByRole("button", { name: "Account" }).dblclick();

	await page.getByLabel("Email").fill("teacher@example.com");
	await page.getByLabel("Password").fill("correct horse battery staple");

	const signInButton = page.getByRole("button", { name: "Sign In", exact: true });
	await expect(signInButton).toBeVisible();
	await signInButton.click();

	await expect(page.getByText("Signed in as Terry")).toBeVisible();
});
