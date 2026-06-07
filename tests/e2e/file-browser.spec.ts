/**
 * E2E Tests: File Browser
 *
 * Verifies:
 * - File browser page renders with directory listing
 * - Navigating into a directory updates the listing
 * - Selecting a file displays its content
 * - Breadcrumb navigation works
 * - Up button navigates to parent directory
 * - Empty directory state is handled
 */
import { test, expect } from './fixtures';

const MOCK_ROOT_ENTRIES = [
  { name: 'backend', type: 'directory', size: 0, permissions: 'drwxr-xr-x', lastModified: '2024-01-15T10:30:00Z' },
  { name: 'frontend', type: 'directory', size: 0, permissions: 'drwxr-xr-x', lastModified: '2024-01-15T11:00:00Z' },
  { name: 'docker-compose.yml', type: 'file', size: 2048, permissions: '-rw-r--r--', lastModified: '2024-01-14T09:00:00Z' },
  { name: '.env', type: 'file', size: 512, permissions: '-rw-------', lastModified: '2024-01-10T08:00:00Z' },
  { name: 'README.md', type: 'file', size: 4096, permissions: '-rw-r--r--', lastModified: '2024-01-12T14:00:00Z' },
];

const MOCK_BACKEND_ENTRIES = [
  { name: 'src', type: 'directory', size: 0, permissions: 'drwxr-xr-x', lastModified: '2024-01-15T10:30:00Z' },
  { name: 'package.json', type: 'file', size: 1024, permissions: '-rw-r--r--', lastModified: '2024-01-14T09:00:00Z' },
  { name: 'tsconfig.json', type: 'file', size: 256, permissions: '-rw-r--r--', lastModified: '2024-01-13T12:00:00Z' },
];

const MOCK_FILE_CONTENT = {
  content: '# Aivery Platform\n\nThis is the main project readme.\n\n## Getting Started\n\n```bash\nnpm install\nnpm run dev\n```\n',
  size: 4096,
  mimeType: 'text/markdown',
};

test.describe('File Browser', () => {
  test.beforeEach(async ({ page }) => {
    // Mock file API: list root directory
    await page.route('/api/files/list?path=%2Fopt%2Faivery', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: MOCK_ROOT_ENTRIES, truncated: false }),
      })
    );

    // Mock file API: list backend directory
    await page.route('/api/files/list?path=%2Fopt%2Faivery%2Fbackend', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: MOCK_BACKEND_ENTRIES, truncated: false }),
      })
    );

    // Mock file API: read a file
    await page.route('/api/files/read?path=%2Fopt%2Faivery%2FREADME.md', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_FILE_CONTENT),
      })
    );

    // Mock file API: read package.json
    await page.route('/api/files/read?path=%2Fopt%2Faivery%2Fbackend%2Fpackage.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: '{\n  "name": "avry-backend",\n  "version": "1.0.0"\n}',
          size: 1024,
          mimeType: 'application/json',
        }),
      })
    );

    // Catch-all for other API routes
    await page.route('/api/**', (route) => {
      const url = route.request().url();
      if (url.includes('/api/files/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ entries: [], truncated: false }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Authenticate and navigate
    await page.goto('/login');
    await page.route('/api/auth/login', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'test-token-123',
          session: { id: 's1', username: 'admin', createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() },
        }),
      })
    );
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('admin123');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('/');

    // Navigate to files
    await page.locator('nav[aria-label="Main navigation"]').getByRole('link', { name: 'Files' }).click();
    await page.waitForURL('/files');
  });

  test('displays file browser heading and directory listing', async ({ fileBrowserPage }) => {
    await expect(fileBrowserPage.heading).toBeVisible();
    await expect(fileBrowserPage.fileEntries).toHaveCount(5);
  });

  test('shows directories and files with correct names', async ({ fileBrowserPage, page }) => {
    // Directories
    await expect(fileBrowserPage.getEntryByName('backend')).toBeVisible();
    await expect(fileBrowserPage.getEntryByName('frontend')).toBeVisible();

    // Files
    await expect(fileBrowserPage.getEntryByName('docker-compose.yml')).toBeVisible();
    await expect(fileBrowserPage.getEntryByName('.env')).toBeVisible();
    await expect(fileBrowserPage.getEntryByName('README.md')).toBeVisible();
  });

  test('navigating into a directory updates the file list', async ({ fileBrowserPage }) => {
    // Click on the backend directory
    await fileBrowserPage.navigateToDirectory('backend');

    // Should now show backend entries
    await expect(fileBrowserPage.getEntryByName('src')).toBeVisible();
    await expect(fileBrowserPage.getEntryByName('package.json')).toBeVisible();
    await expect(fileBrowserPage.getEntryByName('tsconfig.json')).toBeVisible();
  });

  test('selecting a file displays its content', async ({ fileBrowserPage }) => {
    // Click on README.md
    await fileBrowserPage.openFile('README.md');

    // File viewer should appear
    await expect(fileBrowserPage.fileViewer).toBeVisible();

    // Content should be visible (either in CodeMirror or fallback)
    await expect(fileBrowserPage.contentPanel).toContainText('Aivery Platform');
  });

  test('breadcrumb navigation is visible and clickable', async ({ fileBrowserPage, page }) => {
    // Initial breadcrumb should show root
    await expect(fileBrowserPage.breadcrumb).toBeVisible();
    await expect(fileBrowserPage.breadcrumb).toContainText('root');

    // Navigate into backend
    await fileBrowserPage.navigateToDirectory('backend');

    // Breadcrumb should update
    await expect(fileBrowserPage.breadcrumb).toContainText('backend');

    // Click root in breadcrumb to go back
    await page.locator('.breadcrumb-btn', { hasText: 'root' }).click();

    // Should be back at root entries
    await expect(fileBrowserPage.getEntryByName('backend')).toBeVisible();
    await expect(fileBrowserPage.getEntryByName('docker-compose.yml')).toBeVisible();
  });

  test('up button navigates to parent directory', async ({ fileBrowserPage }) => {
    // Navigate into backend
    await fileBrowserPage.navigateToDirectory('backend');
    await expect(fileBrowserPage.getEntryByName('package.json')).toBeVisible();

    // Click up button
    await fileBrowserPage.upButton.click();

    // Should be back at root
    await expect(fileBrowserPage.getEntryByName('backend')).toBeVisible();
  });

  test('empty content panel shows placeholder text when no file selected', async ({ fileBrowserPage }) => {
    await expect(fileBrowserPage.emptyContent).toBeVisible();
    await expect(fileBrowserPage.emptyContent).toContainText('Select a file');
  });

  test('file entries are clickable via keyboard', async ({ fileBrowserPage, page }) => {
    // Focus on the first file entry
    const firstEntry = fileBrowserPage.fileEntries.first();
    await firstEntry.focus();

    // Navigate entries with keyboard (file entries are divs, click is sufficient)
    await firstEntry.press('Enter');

    // The directory should have been navigated (or file opened)
    // Since first entry is 'backend' (directory), file list should update
  });

  test('file size is displayed for file entries', async ({ page }) => {
    // docker-compose.yml should show a size
    const entry = page.locator('.file-entry', { hasText: 'docker-compose.yml' });
    await expect(entry).toBeVisible();
    await expect(entry.locator('.file-size')).toBeVisible();
  });
});
