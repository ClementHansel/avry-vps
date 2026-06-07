/**
 * E2E Tests: Login Flow
 *
 * Verifies:
 * - Login page renders with proper form elements
 * - Successful login redirects to dashboard
 * - Invalid credentials show error message
 * - Form has proper accessibility labels
 * - Keyboard navigation works (Tab through fields, Enter to submit)
 */
import { test, expect, TEST_USER } from './fixtures';

test.describe('Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('displays login form with proper elements', async ({ loginPage }) => {
    // Verify form heading
    await expect(loginPage.heading).toBeVisible();

    // Verify form inputs with proper labels
    await expect(loginPage.usernameInput).toBeVisible();
    await expect(loginPage.passwordInput).toBeVisible();
    await expect(loginPage.submitButton).toBeVisible();

    // Check accessibility: inputs should have associated labels
    const usernameLabel = loginPage.usernameInput.page().locator('label[for="username"]');
    await expect(usernameLabel).toHaveText('Username');

    const passwordLabel = loginPage.passwordInput.page().locator('label[for="password"]');
    await expect(passwordLabel).toHaveText('Password');

    // Check input types
    await expect(loginPage.usernameInput).toHaveAttribute('type', 'text');
    await expect(loginPage.passwordInput).toHaveAttribute('type', 'password');

    // Check autocomplete attributes for password managers
    await expect(loginPage.usernameInput).toHaveAttribute('autocomplete', 'username');
    await expect(loginPage.passwordInput).toHaveAttribute('autocomplete', 'current-password');
  });

  test('submitting valid credentials redirects to dashboard', async ({ loginPage, page }) => {
    await loginPage.loginWithDefaults();

    // Should redirect to dashboard
    await page.waitForURL('/');
    await expect(page).toHaveURL('/');
  });

  test('submitting invalid credentials shows error message', async ({ loginPage }) => {
    await loginPage.login('wronguser', 'wrongpass');

    // Should display error message
    await expect(loginPage.errorMessage).toBeVisible();
    // Error should not reveal which field was wrong (security requirement 6.6)
    const errorText = await loginPage.errorMessage.textContent();
    expect(errorText).not.toMatch(/username/i);
  });

  test('submit button shows loading state during login', async ({ loginPage, page }) => {
    // Slow down the network to observe loading state
    await page.route('/api/auth/login', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-token', session: { id: '1', username: 'admin' } }),
      });
    });

    await loginPage.login(TEST_USER.username, TEST_USER.password);

    // Button should show loading text
    await expect(loginPage.submitButton).toHaveText('Signing in...');
  });

  test('supports keyboard navigation and form submission', async ({ loginPage, page }) => {
    // Tab to username, type, Tab to password, type, Enter to submit
    await loginPage.usernameInput.focus();
    await page.keyboard.type(TEST_USER.username);

    // Tab to password field
    await page.keyboard.press('Tab');
    await expect(loginPage.passwordInput).toBeFocused();

    await page.keyboard.type(TEST_USER.password);

    // Press Enter to submit form
    await page.keyboard.press('Enter');

    // Should attempt login (redirect or show error depending on backend)
    await expect(loginPage.submitButton).toBeVisible();
  });

  test('shows lock indicator when account is locked', async ({ loginPage, page }) => {
    // Mock the login endpoint to return a locked response
    await page.route('/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ locked: true, remainingMinutes: 12 }),
      })
    );

    await loginPage.login('admin', 'wrong');

    // Should show lock banner
    await expect(loginPage.lockBanner).toBeVisible();
    await expect(loginPage.lockBanner).toContainText('temporarily locked');

    // Inputs should be disabled
    await expect(loginPage.usernameInput).toBeDisabled();
    await expect(loginPage.passwordInput).toBeDisabled();
    await expect(loginPage.submitButton).toBeDisabled();
  });

  test('page title is set correctly', async ({ page }) => {
    await expect(page).toHaveTitle(/Aivory VPS Panel/);
  });
});
