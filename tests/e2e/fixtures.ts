/**
 * Shared Playwright fixtures for VPS Panel E2E tests.
 * Provides authentication helpers and page object patterns for reusable test setup.
 */
import { test as base, expect, type Page } from '@playwright/test';

// ─── Credentials ───────────────────────────────────────────────────────────────

const TEST_USER = {
  username: process.env.TEST_USERNAME || 'admin',
  password: process.env.TEST_PASSWORD || 'admin123',
};

// ─── Page Objects ──────────────────────────────────────────────────────────────

export class LoginPage {
  constructor(private page: Page) {}

  get usernameInput() {
    return this.page.locator('#username');
  }

  get passwordInput() {
    return this.page.locator('#password');
  }

  get submitButton() {
    return this.page.locator('button[type="submit"]');
  }

  get errorMessage() {
    return this.page.locator('.error');
  }

  get lockBanner() {
    return this.page.locator('.lock-banner');
  }

  get heading() {
    return this.page.getByRole('heading', { name: /sign in/i });
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async loginWithDefaults() {
    await this.login(TEST_USER.username, TEST_USER.password);
  }
}

export class DashboardPage {
  constructor(private page: Page) {}

  get heading() {
    return this.page.getByRole('heading', { name: 'Dashboard' });
  }

  get serviceSection() {
    return this.page.locator('.service-section');
  }

  get serviceTable() {
    return this.page.locator('.service-table');
  }

  get emptyState() {
    return this.page.locator('.empty-state');
  }

  get resourceWidget() {
    return this.page.locator('.resource-section');
  }

  get summaryCards() {
    return this.page.locator('.summary-grid .card');
  }

  get autoRefreshLabel() {
    return this.page.locator('.auto-refresh-label');
  }
}

export class SidebarNav {
  constructor(private page: Page) {}

  get nav() {
    return this.page.locator('nav[aria-label="Main navigation"]');
  }

  getLink(label: string) {
    return this.nav.getByRole('link', { name: label });
  }

  get dashboardLink() {
    return this.getLink('Dashboard');
  }

  get containersLink() {
    return this.getLink('Containers');
  }

  get filesLink() {
    return this.getLink('Files');
  }

  get domainsLink() {
    return this.getLink('Domains');
  }

  get jobsLink() {
    return this.getLink('Jobs');
  }

  get alertsLink() {
    return this.getLink('Alerts');
  }
}

export class ContainersPage {
  constructor(private page: Page) {}

  get heading() {
    return this.page.getByRole('heading', { name: 'Containers' });
  }

  get containerList() {
    return this.page.locator('.container-list');
  }

  get containerRows() {
    return this.page.locator('.container-row');
  }

  get emptyState() {
    return this.page.locator('.empty-state');
  }

  get detailPanel() {
    return this.page.locator('.detail-panel');
  }

  get restartButton() {
    return this.page.locator('.btn-warning', { hasText: 'Restart' });
  }

  get stopButton() {
    return this.page.locator('.btn-danger', { hasText: 'Stop' });
  }

  get confirmDialog() {
    return this.page.locator('[role="dialog"]');
  }

  get confirmButton() {
    return this.confirmDialog.locator('.btn-danger, .btn-primary').last();
  }

  get cancelButton() {
    return this.confirmDialog.getByRole('button', { name: 'Cancel' });
  }

  async selectContainer(index = 0) {
    await this.containerRows.nth(index).click();
  }
}

export class FileBrowserPage {
  constructor(private page: Page) {}

  get heading() {
    return this.page.getByRole('heading', { name: 'File Browser' });
  }

  get breadcrumb() {
    return this.page.locator('.breadcrumb');
  }

  get fileEntries() {
    return this.page.locator('.file-entry');
  }

  get contentPanel() {
    return this.page.locator('.content-panel');
  }

  get fileViewer() {
    return this.page.locator('.file-viewer');
  }

  get emptyContent() {
    return this.page.locator('.empty-content');
  }

  get upButton() {
    return this.page.locator('.btn-nav', { hasText: 'Up' });
  }

  getEntryByName(name: string) {
    return this.page.locator('.file-entry', { hasText: name });
  }

  async navigateToDirectory(name: string) {
    await this.getEntryByName(name).click();
  }

  async openFile(name: string) {
    await this.getEntryByName(name).click();
  }
}

// ─── Custom Test Fixture ───────────────────────────────────────────────────────

type TestFixtures = {
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  sidebar: SidebarNav;
  containersPage: ContainersPage;
  fileBrowserPage: FileBrowserPage;
  authenticatedPage: Page;
};

/**
 * Extended test fixture that provides page objects and an authenticated page.
 */
export const test = base.extend<TestFixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },

  sidebar: async ({ page }, use) => {
    await use(new SidebarNav(page));
  },

  containersPage: async ({ page }, use) => {
    await use(new ContainersPage(page));
  },

  fileBrowserPage: async ({ page }, use) => {
    await use(new FileBrowserPage(page));
  },

  authenticatedPage: async ({ page }, use) => {
    // Set up authentication by injecting a token into localStorage
    await page.goto('/login');
    const loginPage = new LoginPage(page);
    await loginPage.loginWithDefaults();
    // Wait for navigation to dashboard
    await page.waitForURL('/', { timeout: 10000 }).catch(() => {
      // If redirect doesn't happen, we'll catch it in individual tests
    });
    await use(page);
  },
});

export { expect };
export { TEST_USER };
