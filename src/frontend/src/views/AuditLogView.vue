<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';

interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  actionType: string;
  targetResource: string;
  projectId?: string;
  result: 'success' | 'failure';
}

interface AuditFilters {
  dateFrom: string;
  dateTo: string;
  actor: string;
  actionType: string;
  targetResource: string;
  projectId: string;
  result: string;
}

const authStore = useAuthStore();

const records = ref<AuditRecord[]>([]);
const totalCount = ref(0);
const currentPage = ref(1);
const isLoading = ref(false);
const searchTerm = ref('');
const pageSize = 50;

const filters = ref<AuditFilters>({
  dateFrom: '',
  dateTo: '',
  actor: '',
  actionType: '',
  targetResource: '',
  projectId: '',
  result: '',
});

const totalPages = computed(() => Math.max(1, Math.ceil(totalCount.value / pageSize)));

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function buildQueryParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set('page', String(currentPage.value));
  params.set('pageSize', String(pageSize));

  if (searchTerm.value.trim()) {
    params.set('search', searchTerm.value.trim());
  }
  if (filters.value.dateFrom) params.set('dateFrom', filters.value.dateFrom);
  if (filters.value.dateTo) params.set('dateTo', filters.value.dateTo);
  if (filters.value.actor) params.set('actor', filters.value.actor);
  if (filters.value.actionType) params.set('actionType', filters.value.actionType);
  if (filters.value.targetResource) params.set('targetResource', filters.value.targetResource);
  if (filters.value.projectId) params.set('projectId', filters.value.projectId);
  if (filters.value.result) params.set('result', filters.value.result);

  return params;
}

async function fetchAuditLogs(): Promise<void> {
  isLoading.value = true;
  try {
    const params = buildQueryParams();
    const response = await fetch(`/api/audit?${params.toString()}`, {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });

    if (!response.ok) throw new Error('Failed to fetch audit logs');

    const data = await response.json();
    records.value = data.records;
    totalCount.value = data.total;
  } catch {
    records.value = [];
    totalCount.value = 0;
  } finally {
    isLoading.value = false;
  }
}

function handleSearch(): void {
  currentPage.value = 1;
  fetchAuditLogs();
}

function applyFilters(): void {
  currentPage.value = 1;
  fetchAuditLogs();
}

function clearFilters(): void {
  filters.value = {
    dateFrom: '',
    dateTo: '',
    actor: '',
    actionType: '',
    targetResource: '',
    projectId: '',
    result: '',
  };
  searchTerm.value = '';
  currentPage.value = 1;
  fetchAuditLogs();
}

function goToPage(page: number): void {
  if (page < 1 || page > totalPages.value) return;
  currentPage.value = page;
  fetchAuditLogs();
}

async function exportLogs(format: 'json' | 'csv'): Promise<void> {
  const params = buildQueryParams();
  params.set('format', format);
  params.delete('page');
  params.delete('pageSize');

  const response = await fetch(`/api/audit/export?${params.toString()}`, {
    headers: { Authorization: `Bearer ${authStore.token}` },
  });

  if (!response.ok) return;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

onMounted(() => {
  fetchAuditLogs();
});
</script>

<template>
  <div class="audit-log-view">
    <div class="view-header">
      <h2>Audit Log</h2>
      <div class="export-buttons">
        <button class="btn-export" @click="exportLogs('json')">Export JSON</button>
        <button class="btn-export" @click="exportLogs('csv')">Export CSV</button>
      </div>
    </div>

    <!-- Search and filters -->
    <div class="search-bar">
      <input
        v-model="searchTerm"
        type="text"
        placeholder="Full-text search..."
        class="search-input"
        @keyup.enter="handleSearch"
      />
      <button class="btn-search" @click="handleSearch">Search</button>
    </div>

    <div class="filters-section">
      <div class="filter-row">
        <div class="filter-group">
          <label for="filter-date-from">From</label>
          <input id="filter-date-from" v-model="filters.dateFrom" type="date" class="filter-input" />
        </div>
        <div class="filter-group">
          <label for="filter-date-to">To</label>
          <input id="filter-date-to" v-model="filters.dateTo" type="date" class="filter-input" />
        </div>
        <div class="filter-group">
          <label for="filter-actor">Actor</label>
          <input id="filter-actor" v-model="filters.actor" type="text" placeholder="Username" class="filter-input" />
        </div>
        <div class="filter-group">
          <label for="filter-action">Action</label>
          <input id="filter-action" v-model="filters.actionType" type="text" placeholder="Action type" class="filter-input" />
        </div>
        <div class="filter-group">
          <label for="filter-target">Target</label>
          <input id="filter-target" v-model="filters.targetResource" type="text" placeholder="Resource" class="filter-input" />
        </div>
        <div class="filter-group">
          <label for="filter-result">Result</label>
          <select id="filter-result" v-model="filters.result" class="filter-input">
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </div>
      </div>
      <div class="filter-actions">
        <button class="btn-filter" @click="applyFilters">Apply Filters</button>
        <button class="btn-clear" @click="clearFilters">Clear</button>
      </div>
    </div>

    <!-- Loading / Empty -->
    <p v-if="isLoading" class="muted">Loading audit logs...</p>

    <p v-else-if="records.length === 0" class="empty-state">
      No audit log entries found.
    </p>

    <!-- Audit table -->
    <div v-else class="audit-table">
      <div class="table-header">
        <span class="col-timestamp">Timestamp</span>
        <span class="col-actor">Actor</span>
        <span class="col-action">Action</span>
        <span class="col-target">Target</span>
        <span class="col-project">Project</span>
        <span class="col-result">Result</span>
      </div>
      <div
        v-for="record in records"
        :key="record.id"
        class="table-row"
      >
        <span class="col-timestamp">{{ formatTimestamp(record.timestamp) }}</span>
        <span class="col-actor">{{ record.actor }}</span>
        <span class="col-action">{{ record.actionType }}</span>
        <span class="col-target">{{ record.targetResource }}</span>
        <span class="col-project">{{ record.projectId ?? '—' }}</span>
        <span class="col-result">
          <span :class="['result-badge', record.result]">{{ record.result }}</span>
        </span>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="pagination">
      <button
        class="btn-page"
        :disabled="currentPage === 1"
        @click="goToPage(currentPage - 1)"
      >
        ← Prev
      </button>
      <span class="page-info">
        Page {{ currentPage }} of {{ totalPages }}
        <span class="total-records">({{ totalCount }} entries)</span>
      </span>
      <button
        class="btn-page"
        :disabled="currentPage === totalPages"
        @click="goToPage(currentPage + 1)"
      >
        Next →
      </button>
    </div>
  </div>
</template>

<style scoped>
.audit-log-view h2 {
  margin-bottom: 0;
}

.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.export-buttons {
  display: flex;
  gap: 0.5rem;
}

.btn-export {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  border-radius: 0.375rem;
  cursor: pointer;
}

.btn-export:hover {
  background: var(--color-surface-hover);
}

.search-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.search-input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  color: var(--color-text);
  font-size: 0.875rem;
}

.search-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.btn-search {
  padding: 0.5rem 1rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
}

.btn-search:hover {
  background: var(--color-primary-hover);
}

.filters-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}

.filter-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.filter-group label {
  display: block;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-bottom: 0.25rem;
}

.filter-input {
  width: 100%;
  padding: 0.375rem 0.5rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 0.25rem;
  color: var(--color-text);
  font-size: 0.8125rem;
}

.filter-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-filter {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
}

.btn-filter:hover {
  background: var(--color-primary-hover);
}

.btn-clear {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  border-radius: 0.375rem;
  cursor: pointer;
}

.btn-clear:hover {
  background: var(--color-surface-hover);
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  background: var(--color-surface);
  padding: 2rem;
  border-radius: 0.5rem;
  border: 1px dashed var(--color-border);
  text-align: center;
}

.audit-table {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  overflow-x: auto;
}

.table-header,
.table-row {
  display: grid;
  grid-template-columns: 170px 120px 140px 1fr 100px 80px;
  padding: 0.75rem 1rem;
  align-items: center;
  min-width: max-content;
}

.table-header {
  background: var(--color-surface-hover);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  letter-spacing: 0.05em;
}

.table-row {
  border-top: 1px solid var(--color-border);
  font-size: 0.8125rem;
}

.table-row:hover {
  background: var(--color-surface-hover);
}

.col-timestamp {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-family: monospace;
}

.col-actor {
  font-weight: 500;
}

.col-project {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.result-badge {
  display: inline-block;
  font-size: 0.6875rem;
  text-transform: uppercase;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-weight: 600;
}

.result-badge.success {
  background: rgba(34, 197, 94, 0.15);
  color: var(--color-success);
}

.result-badge.failure {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-danger);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
  padding: 0.75rem;
}

.btn-page {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  border-radius: 0.375rem;
  cursor: pointer;
}

.btn-page:hover:not(:disabled) {
  background: var(--color-surface-hover);
}

.btn-page:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-info {
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.total-records {
  font-size: 0.75rem;
}
</style>
