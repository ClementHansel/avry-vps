<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();

interface DatabaseServer {
  id: string;
  type: 'mysql' | 'mariadb' | 'postgresql';
  containerName: string;
  host: string;
  port: number;
}

interface DatabaseInfo {
  name: string;
  size: string;
  tables: number;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTime: number;
}

const servers = ref<DatabaseServer[]>([]);
const databases = ref<DatabaseInfo[]>([]);
const selectedServer = ref<DatabaseServer | null>(null);
const selectedDatabase = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// Query editor
const queryText = ref('');
const queryResult = ref<QueryResult | null>(null);
const queryLoading = ref(false);
const queryError = ref<string | null>(null);

// Export/Import
const exportLoading = ref(false);
const importLoading = ref(false);
const importProgress = ref<number | null>(null);

// User management
const showUserForm = ref(false);
const userFormName = ref('');
const userFormPassword = ref('');
const userFormPrivileges = ref('ALL');

function headers() {
  return { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' };
}

async function discoverServers(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/databases/servers', { headers: headers() });
    if (!res.ok) throw new Error('Failed to discover database servers');
    servers.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

async function selectServer(server: DatabaseServer): Promise<void> {
  selectedServer.value = server;
  selectedDatabase.value = null;
  queryResult.value = null;
  queryError.value = null;
  loading.value = true;

  try {
    const res = await fetch(`/api/databases/${server.id}/databases`, { headers: headers() });
    if (!res.ok) throw new Error('Failed to list databases');
    databases.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

function selectDatabase(dbName: string): void {
  selectedDatabase.value = dbName;
  queryResult.value = null;
  queryError.value = null;
}

async function executeQuery(): Promise<void> {
  if (!selectedServer.value || !selectedDatabase.value || !queryText.value.trim()) return;

  queryLoading.value = true;
  queryError.value = null;
  queryResult.value = null;

  try {
    const res = await fetch(`/api/databases/${selectedServer.value.id}/query`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        database: selectedDatabase.value,
        query: queryText.value,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Query execution failed');
    }

    queryResult.value = await res.json();
  } catch (err) {
    queryError.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    queryLoading.value = false;
  }
}

async function exportDatabase(): Promise<void> {
  if (!selectedServer.value || !selectedDatabase.value) return;

  exportLoading.value = true;
  error.value = null;

  try {
    const res = await fetch(`/api/databases/${selectedServer.value.id}/export`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ database: selectedDatabase.value }),
    });

    if (!res.ok) throw new Error('Failed to start database export');
    const data = await res.json();
    // Job ID returned — export runs in background
    alert(`Export started. Job ID: ${data.jobId}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    exportLoading.value = false;
  }
}

async function importDatabase(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !selectedServer.value || !selectedDatabase.value) return;

  importLoading.value = true;
  importProgress.value = 0;
  error.value = null;

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('database', selectedDatabase.value);

    const res = await fetch(`/api/databases/${selectedServer.value.id}/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authStore.token}` },
      body: formData,
    });

    if (!res.ok) throw new Error('Failed to start database import');
    const data = await res.json();
    alert(`Import started. Job ID: ${data.jobId}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    importLoading.value = false;
    importProgress.value = null;
    input.value = '';
  }
}

async function createUser(): Promise<void> {
  if (!selectedServer.value || !selectedDatabase.value) return;
  error.value = null;

  try {
    const res = await fetch(`/api/databases/${selectedServer.value.id}/users`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        database: selectedDatabase.value,
        username: userFormName.value,
        password: userFormPassword.value,
        privileges: userFormPrivileges.value,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Failed to create user');
    }

    showUserForm.value = false;
    userFormName.value = '';
    userFormPassword.value = '';
    userFormPrivileges.value = 'ALL';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  }
}

function serverTypeIcon(type: string): string {
  if (type === 'postgresql') return '🐘';
  return '🐬';
}

onMounted(() => {
  discoverServers();
});
</script>

<template>
  <div class="databases-view">
    <div class="view-header">
      <h2>Databases</h2>
      <button class="btn btn-secondary" @click="discoverServers" :disabled="loading">
        Refresh Servers
      </button>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner">
      <span>{{ error }}</span>
      <button class="dismiss-btn" @click="error = null">×</button>
    </div>

    <div class="db-layout">
      <!-- Server Discovery -->
      <div class="sidebar">
        <h3 class="sidebar-title">Servers</h3>
        <p v-if="loading && servers.length === 0" class="muted">Discovering...</p>
        <p v-else-if="servers.length === 0" class="muted">No database servers found.</p>
        <div
          v-for="server in servers"
          :key="server.id"
          :class="['server-item', { active: selectedServer?.id === server.id }]"
          @click="selectServer(server)"
        >
          <span class="server-icon">{{ serverTypeIcon(server.type) }}</span>
          <div class="server-info">
            <span class="server-name">{{ server.containerName }}</span>
            <span class="server-type">{{ server.type }} · :{{ server.port }}</span>
          </div>
        </div>

        <!-- Database list -->
        <template v-if="selectedServer">
          <h3 class="sidebar-title mt">Databases</h3>
          <p v-if="databases.length === 0" class="muted">No databases found.</p>
          <div
            v-for="db in databases"
            :key="db.name"
            :class="['db-item', { active: selectedDatabase === db.name }]"
            @click="selectDatabase(db.name)"
          >
            <span class="db-name">{{ db.name }}</span>
            <span class="db-meta">{{ db.size }} · {{ db.tables }} tables</span>
          </div>
        </template>
      </div>

      <!-- Main content -->
      <div class="main-content">
        <template v-if="!selectedServer">
          <div class="empty-state">
            <p>Select a database server to begin.</p>
            <p class="muted">Database containers (MySQL, MariaDB, PostgreSQL) are auto-discovered.</p>
          </div>
        </template>

        <template v-else-if="!selectedDatabase">
          <div class="empty-state">
            <p>Select a database from the sidebar.</p>
          </div>
        </template>

        <template v-else>
          <!-- Toolbar -->
          <div class="db-toolbar">
            <span class="db-toolbar-title">{{ selectedDatabase }}</span>
            <div class="toolbar-actions">
              <button class="btn btn-secondary" @click="showUserForm = true">Manage Users</button>
              <button class="btn btn-secondary" :disabled="exportLoading" @click="exportDatabase">
                {{ exportLoading ? 'Exporting...' : 'Export' }}
              </button>
              <label class="btn btn-secondary import-btn" :class="{ disabled: importLoading }">
                {{ importLoading ? `Importing...` : 'Import' }}
                <input type="file" accept=".sql,.gz" hidden @change="importDatabase" :disabled="importLoading" />
              </label>
            </div>
          </div>

          <!-- Import progress -->
          <div v-if="importProgress !== null" class="progress-bar">
            <div class="progress-fill" :style="{ width: `${importProgress}%` }"></div>
          </div>

          <!-- User management form -->
          <div v-if="showUserForm" class="form-card">
            <h3>Create Database User</h3>
            <form @submit.prevent="createUser">
              <div class="form-row">
                <div class="form-group">
                  <label for="user-name">Username</label>
                  <input id="user-name" v-model="userFormName" type="text" required />
                </div>
                <div class="form-group">
                  <label for="user-password">Password</label>
                  <input id="user-password" v-model="userFormPassword" type="password" required />
                </div>
                <div class="form-group">
                  <label for="user-privileges">Privileges</label>
                  <select id="user-privileges" v-model="userFormPrivileges">
                    <option value="ALL">ALL PRIVILEGES</option>
                    <option value="READ">READ ONLY</option>
                    <option value="READWRITE">READ/WRITE</option>
                  </select>
                </div>
              </div>
              <div class="form-actions">
                <button type="button" class="btn btn-secondary" @click="showUserForm = false">Cancel</button>
                <button type="submit" class="btn btn-primary">Create User</button>
              </div>
            </form>
          </div>

          <!-- Query editor -->
          <div class="query-editor">
            <label for="sql-query" class="query-label">SQL Query</label>
            <textarea
              id="sql-query"
              v-model="queryText"
              class="query-input"
              rows="5"
              placeholder="SELECT * FROM ..."
              @keydown.ctrl.enter="executeQuery"
            ></textarea>
            <div class="query-actions">
              <button class="btn btn-primary" :disabled="queryLoading || !queryText.trim()" @click="executeQuery">
                {{ queryLoading ? 'Executing...' : 'Execute (Ctrl+Enter)' }}
              </button>
            </div>
          </div>

          <!-- Query error -->
          <div v-if="queryError" class="query-error">
            <span>{{ queryError }}</span>
          </div>

          <!-- Query results -->
          <div v-if="queryResult" class="query-results">
            <div class="results-meta">
              <span>{{ queryResult.rowCount }} row(s) returned</span>
              <span class="muted">· {{ queryResult.executionTime }}ms</span>
            </div>
            <div class="table-wrapper">
              <table class="data-table results-table">
                <thead>
                  <tr>
                    <th v-for="col in queryResult.columns" :key="col">{{ col }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in queryResult.rows" :key="i">
                    <td v-for="col in queryResult.columns" :key="col">
                      {{ row[col] ?? 'NULL' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.databases-view h2 {
  margin: 0;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  color: var(--color-danger);
}

.dismiss-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  cursor: pointer;
  color: inherit;
  padding: 0 0.25rem;
}

/* Layout */
.db-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 1.5rem;
  align-items: start;
}

@media (max-width: 768px) {
  .db-layout {
    grid-template-columns: 1fr;
  }
}

/* Sidebar */
.sidebar {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1rem;
}

.sidebar-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.025em;
  color: var(--color-text-muted);
  margin-bottom: 0.75rem;
}

.sidebar-title.mt {
  margin-top: 1.25rem;
}

.server-item,
.db-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background-color 0.2s;
  margin-bottom: 0.25rem;
}

.server-item:hover,
.db-item:hover {
  background: var(--color-surface-hover);
}

.server-item.active,
.db-item.active {
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.3);
}

.server-icon {
  font-size: 1.25rem;
}

.server-info {
  display: flex;
  flex-direction: column;
}

.server-name {
  font-size: 0.8125rem;
  font-weight: 500;
}

.server-type {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.db-item {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.125rem;
}

.db-name {
  font-size: 0.8125rem;
  font-weight: 500;
}

.db-meta {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

/* Main content */
.main-content {
  min-height: 400px;
}

/* Toolbar */
.db-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.db-toolbar-title {
  font-size: 1rem;
  font-weight: 600;
}

.toolbar-actions {
  display: flex;
  gap: 0.5rem;
}

.import-btn {
  cursor: pointer;
}

.import-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Progress bar */
.progress-bar {
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  margin-bottom: 1rem;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.3s;
}

/* Form */
.form-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1.25rem;
  margin-bottom: 1.5rem;
}

.form-card h3 {
  font-size: 0.9375rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.form-group {
  margin-bottom: 0.875rem;
}

.form-group label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text-muted);
}

.form-group input[type="text"],
.form-group input[type="password"],
.form-group select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.875rem;
  color: var(--color-text);
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--color-primary);
}

.form-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.form-row .form-group {
  flex: 1;
  min-width: 150px;
}

.form-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  margin-top: 1rem;
}

/* Query editor */
.query-editor {
  margin-bottom: 1rem;
}

.query-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text-muted);
}

.query-input {
  width: 100%;
  padding: 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-family: 'Courier New', Courier, monospace;
  color: var(--color-text);
  resize: vertical;
}

.query-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.query-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
}

.query-error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.8125rem;
  font-family: 'Courier New', Courier, monospace;
  color: var(--color-danger);
}

/* Results */
.query-results {
  margin-top: 1rem;
}

.results-meta {
  font-size: 0.8125rem;
  margin-bottom: 0.5rem;
  font-weight: 500;
}

.table-wrapper {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow: hidden;
}

.data-table th,
.data-table td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-size: 0.75rem;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.data-table th {
  background: var(--color-bg);
  font-weight: 600;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.results-table td {
  font-family: 'Courier New', Courier, monospace;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Buttons */
.btn {
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.btn-secondary {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-border);
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.empty-state {
  background: var(--color-surface);
  border: 1px dashed var(--color-border);
  border-radius: 0.5rem;
  padding: 3rem;
  text-align: center;
}

.empty-state p:first-child {
  font-weight: 500;
  margin-bottom: 0.25rem;
}
</style>
