<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useAuthStore } from '@/stores/auth';

interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  permissions: string;
  lastModified: string;
}

interface FileContent {
  content: string;
  size: number;
  mimeType: string;
}

const authStore = useAuthStore();

const currentPath = ref('/opt/aivery');
const entries = ref<FileEntry[]>([]);
const isTruncated = ref(false);
const selectedFile = ref<FileEntry | null>(null);
const fileContent = ref('');
const originalContent = ref('');
const isEditing = ref(false);
const isLoading = ref(false);
const isLoadingFile = ref(false);
const isSaving = ref(false);
const error = ref<string | null>(null);
const fileError = ref<string | null>(null);
const saveSuccess = ref(false);
const fileTooLarge = ref(false);
const fileMetadata = ref<FileEntry | null>(null);

// Editor instance ref
let editorView: any = null;
const editorContainer = ref<HTMLElement | null>(null);

const pathParts = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    name: part,
    path: '/' + parts.slice(0, index + 1).join('/'),
  }));
});

const hasUnsavedChanges = computed(() => {
  return isEditing.value && fileContent.value !== originalContent.value;
});

async function fetchDirectory(path: string): Promise<void> {
  isLoading.value = true;
  error.value = null;
  selectedFile.value = null;
  fileContent.value = '';
  fileTooLarge.value = false;
  fileError.value = null;

  try {
    const response = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });

    if (!response.ok) throw new Error('Failed to load directory');

    const data = await response.json();
    entries.value = data.entries ?? [];
    isTruncated.value = data.truncated ?? false;
    currentPath.value = path;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isLoading.value = false;
  }
}

async function openFile(entry: FileEntry): Promise<void> {
  if (entry.type === 'directory') {
    const newPath = currentPath.value === '/'
      ? `/${entry.name}`
      : `${currentPath.value}/${entry.name}`;
    await fetchDirectory(newPath);
    return;
  }

  // Check size limit (10MB)
  if (entry.size > 10 * 1024 * 1024) {
    fileTooLarge.value = true;
    fileMetadata.value = entry;
    selectedFile.value = entry;
    fileContent.value = '';
    isEditing.value = false;
    return;
  }

  fileTooLarge.value = false;
  fileMetadata.value = null;
  isLoadingFile.value = true;
  fileError.value = null;

  try {
    const filePath = currentPath.value === '/'
      ? `/${entry.name}`
      : `${currentPath.value}/${entry.name}`;

    const response = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`, {
      headers: { Authorization: `Bearer ${authStore.token}` },
    });

    if (!response.ok) throw new Error('Failed to read file');

    const data: FileContent = await response.json();
    selectedFile.value = entry;
    fileContent.value = data.content;
    originalContent.value = data.content;
    isEditing.value = false;
    await initEditor(data.content, entry.name);
  } catch (err) {
    fileError.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    isLoadingFile.value = false;
  }
}

async function initEditor(content: string, filename: string): Promise<void> {
  if (!editorContainer.value) return;

  // Clean up previous editor
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }

  try {
    const { EditorView, basicSetup } = await import('@codemirror/basic-setup');
    const { EditorState } = await import('@codemirror/state');

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            fileContent.value = update.state.doc.toString();
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { fontFamily: 'monospace' },
          '&.cm-focused': { outline: 'none' },
        }),
        EditorView.editable.of(isEditing.value),
      ],
    });

    editorView = new EditorView({
      state,
      parent: editorContainer.value,
    });
  } catch {
    // Fallback: display content as plain text if CodeMirror fails to load
  }
}

function toggleEdit(): void {
  isEditing.value = !isEditing.value;
  if (editorView && selectedFile.value) {
    // Reinitialize editor with editing capability
    initEditor(fileContent.value, selectedFile.value.name);
  }
}

async function saveFile(): Promise<void> {
  if (!selectedFile.value) return;

  isSaving.value = true;
  fileError.value = null;
  saveSuccess.value = false;

  const filePath = currentPath.value === '/'
    ? `/${selectedFile.value.name}`
    : `${currentPath.value}/${selectedFile.value.name}`;

  try {
    const response = await fetch('/api/files/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.token}`,
      },
      body: JSON.stringify({ path: filePath, content: fileContent.value }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({ message: 'Save failed' }));
      throw new Error(data.message || 'Save failed');
    }

    originalContent.value = fileContent.value;
    saveSuccess.value = true;
    // Keep success visible for 3 seconds
    setTimeout(() => { saveSuccess.value = false; }, 3000);
  } catch (err) {
    // Preserve unsaved content in editor on failure (don't clear fileContent)
    fileError.value = err instanceof Error ? err.message : 'Failed to save file';
  } finally {
    isSaving.value = false;
  }
}

function navigateUp(): void {
  const parentPath = currentPath.value.split('/').slice(0, -1).join('/') || '/';
  fetchDirectory(parentPath);
}

function navigateTo(path: string): void {
  fetchDirectory(path);
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString();
}

function getFileIcon(entry: FileEntry): string {
  if (entry.type === 'directory') return '📁';
  if (entry.type === 'symlink') return '🔗';
  const ext = entry.name.split('.').pop()?.toLowerCase();
  const iconMap: Record<string, string> = {
    ts: '📘', js: '📒', vue: '💚', py: '🐍', json: '📋',
    yml: '⚙️', yaml: '⚙️', md: '📝', sh: '🖥️', log: '📄',
    env: '🔒', conf: '⚙️', txt: '📄',
  };
  return iconMap[ext ?? ''] ?? '📄';
}

onMounted(() => {
  fetchDirectory(currentPath.value);
});

onBeforeUnmount(() => {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
});
</script>

<template>
  <div class="files-view">
    <h2>File Browser</h2>

    <div class="files-layout">
      <!-- Left panel: directory tree -->
      <div class="directory-panel">
        <div class="breadcrumb">
          <button class="breadcrumb-btn" @click="navigateTo('/opt/aivery')">🏠 root</button>
          <span v-for="part in pathParts" :key="part.path" class="breadcrumb-item">
            <span class="breadcrumb-sep">/</span>
            <button class="breadcrumb-btn" @click="navigateTo(part.path)">{{ part.name }}</button>
          </span>
        </div>

        <div class="directory-actions">
          <button
            class="btn-nav"
            :disabled="currentPath === '/opt/aivery'"
            @click="navigateUp"
          >
            ⬆️ Up
          </button>
        </div>

        <div v-if="isLoading" class="loading-state">Loading...</div>
        <div v-else-if="error" class="error-state">{{ error }}</div>
        <div v-else class="file-list">
          <div
            v-for="entry in entries"
            :key="entry.name"
            class="file-entry"
            :class="{ active: selectedFile?.name === entry.name && entry.type === 'file' }"
            @click="openFile(entry)"
          >
            <span class="file-icon">{{ getFileIcon(entry) }}</span>
            <span class="file-name">{{ entry.name }}</span>
            <span class="file-size">{{ entry.type === 'directory' ? '—' : formatSize(entry.size) }}</span>
          </div>

          <div v-if="entries.length === 0" class="empty-state">
            Directory is empty
          </div>

          <div v-if="isTruncated" class="truncation-notice">
            ⚠️ Showing first 500 entries. Directory contains more items.
          </div>
        </div>
      </div>

      <!-- Right panel: file content viewer -->
      <div class="content-panel">
        <div v-if="!selectedFile && !fileTooLarge" class="empty-content">
          <p>Select a file to view its contents</p>
        </div>

        <div v-else-if="fileTooLarge && fileMetadata" class="file-too-large">
          <div class="too-large-icon">⚠️</div>
          <h3>File too large to display</h3>
          <p>This file exceeds the 10 MB size limit for viewing.</p>
          <div class="file-meta">
            <div><strong>Name:</strong> {{ fileMetadata.name }}</div>
            <div><strong>Size:</strong> {{ formatSize(fileMetadata.size) }}</div>
            <div><strong>Permissions:</strong> {{ fileMetadata.permissions }}</div>
            <div><strong>Last modified:</strong> {{ formatDate(fileMetadata.lastModified) }}</div>
          </div>
        </div>

        <div v-else-if="selectedFile" class="file-viewer">
          <div class="file-header">
            <div class="file-title">
              <span>{{ selectedFile.name }}</span>
              <span class="file-size-badge">{{ formatSize(selectedFile.size) }}</span>
            </div>
            <div class="file-actions">
              <button
                class="btn-action"
                :class="{ active: isEditing }"
                @click="toggleEdit"
              >
                {{ isEditing ? '👁️ View' : '✏️ Edit' }}
              </button>
              <button
                v-if="isEditing"
                class="btn-save"
                :disabled="isSaving || !hasUnsavedChanges"
                @click="saveFile"
              >
                {{ isSaving ? 'Saving...' : '💾 Save' }}
              </button>
            </div>
          </div>

          <div v-if="saveSuccess" class="save-success">
            ✅ File saved successfully
          </div>
          <div v-if="fileError" class="file-error">
            ❌ {{ fileError }}
          </div>

          <div v-if="isLoadingFile" class="loading-state">Loading file...</div>
          <div v-else class="editor-wrapper" ref="editorContainer">
            <!-- CodeMirror mounts here -->
            <pre v-if="!editorView" class="fallback-content">{{ fileContent }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.files-view h2 {
  margin-bottom: 1rem;
}

.files-layout {
  display: grid;
  grid-template-columns: 350px 1fr;
  gap: 1rem;
  height: calc(100vh - 160px);
}

.directory-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  padding: 0.75rem;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.8rem;
  gap: 0.125rem;
}

.breadcrumb-btn {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.125rem 0.25rem;
  border-radius: 0.25rem;
}

.breadcrumb-btn:hover {
  background: var(--color-surface-hover);
}

.breadcrumb-sep {
  color: var(--color-text-muted);
}

.directory-actions {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}

.btn-nav {
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  padding: 0.375rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-nav:hover:not(:disabled) {
  background: var(--color-primary);
}

.btn-nav:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.file-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem;
}

.file-entry {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.file-entry:hover {
  background: var(--color-surface-hover);
}

.file-entry.active {
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid var(--color-primary);
}

.file-icon {
  flex-shrink: 0;
}

.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  flex-shrink: 0;
}

.truncation-notice {
  padding: 0.75rem;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid var(--color-warning);
  border-radius: 0.25rem;
  margin: 0.5rem;
  font-size: 0.8rem;
  color: var(--color-warning);
}

.content-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.empty-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.file-too-large {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 2rem;
  text-align: center;
}

.too-large-icon {
  font-size: 3rem;
}

.file-too-large h3 {
  color: var(--color-warning);
}

.file-meta {
  background: var(--color-bg);
  padding: 1rem;
  border-radius: 0.375rem;
  text-align: left;
  font-size: 0.85rem;
  line-height: 2;
}

.file-viewer {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--color-border);
}

.file-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 500;
}

.file-size-badge {
  font-size: 0.75rem;
  background: var(--color-bg);
  padding: 0.125rem 0.5rem;
  border-radius: 1rem;
  color: var(--color-text-muted);
}

.file-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-action {
  background: var(--color-surface-hover);
  border: 1px solid var(--color-border);
  color: var(--color-text);
  padding: 0.375rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-action:hover {
  background: var(--color-primary);
}

.btn-action.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.btn-save {
  background: var(--color-success);
  border: none;
  color: #fff;
  padding: 0.375rem 0.75rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.save-success {
  padding: 0.5rem 1rem;
  background: rgba(34, 197, 94, 0.1);
  border-bottom: 1px solid var(--color-success);
  color: var(--color-success);
  font-size: 0.85rem;
}

.file-error {
  padding: 0.5rem 1rem;
  background: rgba(239, 68, 68, 0.1);
  border-bottom: 1px solid var(--color-danger);
  color: var(--color-danger);
  font-size: 0.85rem;
}

.editor-wrapper {
  flex: 1;
  overflow: auto;
}

.fallback-content {
  padding: 1rem;
  font-family: monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-all;
}

.loading-state {
  padding: 2rem;
  text-align: center;
  color: var(--color-text-muted);
}

.error-state {
  padding: 1rem;
  color: var(--color-danger);
  text-align: center;
}

.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}
</style>
