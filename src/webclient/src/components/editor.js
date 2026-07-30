/**
 * Editor Component
 * Lazy-loaded Monaco Editor integration with file loading/saving
 */

import { getActiveClient } from '../utils/session-manager.js';
import { getMachineClient } from '../api/machine-client.js';
import { debug } from '../utils/debug.js';

// Global Monaco reference (will be loaded from CDN via import map)
let monaco = null;

// Active editor instances
const editors = new Map();
let monacoLoaded = false;

function showEditorMessage(editorId, message, type = 'info') {
    const instance = editors.get(editorId);
    if (!instance?.container) return;

    let statusEl = instance.container
        .closest('.tool-container')
        ?.querySelector('.editor-status-message');

    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.dataset.type = type;
    statusEl.classList.add('visible');

    if (instance.messageTimeoutId) {
        clearTimeout(instance.messageTimeoutId);
    }

    instance.messageTimeoutId = setTimeout(() => {
        statusEl.classList.remove('visible');
    }, 2500);
}

/**
 * Load Monaco Editor (one-time initialization)
 */
async function loadMonaco() {
    if (monacoLoaded) return;

    try {
        // Dynamically import Monaco (resolved via import map in index.html)
        const monacoModule = await import('monaco-editor');
        monaco = monacoModule;
        monacoLoaded = true;
        debug.log('✅ Monaco Editor loaded');
    } catch (err) {
        console.error('❌ Failed to load Monaco:', err);
        throw err;
    }
}

/**
 * Create and mount an editor instance
 * @param {string} containerId - DOM element ID to mount editor
 * @param {string} filePath - File path to load
 * @returns {Promise<string>} Editor instance ID
 */
export async function createEditor(containerId, filePath, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error('Editor container not found:', containerId);
        return null;
    }

    // Load Monaco if not already loaded
    await loadMonaco();

    // Per-tab machine identity (D2): an editor opened on machine A must read
    // and write through A's client even after the active machine changes.
    const machineId = options.machineId || 'self';

    // Load file content (or empty for new files)
    let content = '';
    let language = 'plaintext';

    if (filePath) {
        content = await loadFileContent(filePath, machineId);
        language = detectLanguage(filePath);
    }

    // Create editor instance
    if (!monaco) {
        throw new Error('Monaco not loaded');
    }

    const isInitialReadOnly = options.readOnly !== undefined ? !!options.readOnly : !!filePath;

    const editor = monaco.editor.create(container, {
        value: content,
        language: language,
        theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        readOnly: isInitialReadOnly,
    });

    const editorId = `editor-${Date.now()}`;

    // Handle theme changes — #7: store on the instance so destroyEditor can
    // disconnect it (otherwise every opened editor leaks a MutationObserver).
    const observer = new MutationObserver(() => {
        const isDark = document.documentElement.classList.contains('dark');
        monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Store instance
    editors.set(editorId, {
        editor,
        container,
        filePath,
        machineId,
        dirty: false,
        readOnly: isInitialReadOnly,
        messageTimeoutId: null,
        observer,
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        const instance = editors.get(editorId);
        if (instance && !instance.readOnly) {
            await saveEditor(editorId);
        }
    });

    // Track modifications
    editor.onDidChangeModelContent(() => {
        const instance = editors.get(editorId);
        if (instance) {
            instance.dirty = true;
        }
    });

    debug.log('✅ Editor created:', editorId, 'for', filePath, 'on', machineId);
    return editorId;
}

/**
 * Load file content from backend via /fs/read
 * @param {string} path - File path
 * @returns {Promise<string>} File content
 */
async function loadFileContent(path, machineId) {
    try {
        const client = getMachineClient(machineId);
        const blob = await client.readBlob(path);
        return await blob.text();
    } catch (error) {
        console.error('Failed to load file:', error);
        return `// Error loading file: ${error.message}`;
    }
}

/**
 * Detect language from file extension
 * @param {string} filePath - File path
 * @returns {string} Monaco language ID
 */
function detectLanguage(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    
    const languageMap = {
        'js': 'javascript',
        'ts': 'typescript',
        'jsx': 'javascript',
        'tsx': 'typescript',
        'json': 'javascript',  // json map appears fail to load or Monaco doesn't recognize it, so use js which has similar syntax highlighting
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'py': 'python',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'sh': 'shell',
        'bash': 'shell',
        'sql': 'sql',
        'md': 'markdown',
        'xml': 'xml',
        'yaml': 'yaml',
        'yml': 'yaml',
        'txt': 'plaintext',
    };

    return languageMap[ext] || 'plaintext';
}

/**
 * Save editor content to backend
 * @param {string} editorId - Editor instance ID
 * @returns {Promise<boolean>} Success status
 */
export async function saveEditor(editorId) {
    const instance = editors.get(editorId);
    if (!instance) {
        console.error('Editor not found:', editorId);
        return false;
    }

    const content = instance.editor.getValue();
    const filePath = instance.filePath;

    if (!filePath) {
        showEditorMessage(editorId, 'Save failed: no file path', 'error');
        return false;
    }

    try {
        await getMachineClient(instance.machineId).write(filePath, content);

        instance.dirty = false;
        debug.log('✅ File saved:', filePath);
        showEditorMessage(editorId, 'Saved', 'success');
        return true;
    } catch (error) {
        console.error('Failed to save file:', error);
        showEditorMessage(editorId, `Save failed: ${error.message}`, 'error');
        return false;
    }
}

/**
 * Destroy an editor instance
 * @param {string} editorId - Editor instance ID
 */
export function destroyEditor(editorId) {
    const instance = editors.get(editorId);
    if (!instance) return;

    // #7: disconnect the theme MutationObserver so it doesn't outlive the editor.
    if (instance.observer) {
        instance.observer.disconnect();
    }

    if (instance.messageTimeoutId) {
        clearTimeout(instance.messageTimeoutId);
    }

    // Dispose Monaco instance
    instance.editor.dispose();

    // Remove from map
    editors.delete(editorId);

    debug.log('🗑️ Editor destroyed:', editorId);
}

/**
 * Get editor instance
 * @param {string} editorId - Editor instance ID
 * @returns {object|null} Editor instance
 */
export function getEditor(editorId) {
    return editors.get(editorId) || null;
}

/**
 * Check if editor has unsaved changes
 * @param {string} editorId - Editor instance ID
 * @returns {boolean} True if dirty
 */
export function isEditorDirty(editorId) {
    const instance = editors.get(editorId);
    return instance ? instance.dirty : false;
}

/**
 * Set the read-only state of an editor
 * @param {string} editorId - Editor instance ID
 * @param {boolean} isReadOnly - Read-only state
 */
export function setEditorReadOnly(editorId, isReadOnly) {
    const instance = editors.get(editorId);
    if (!instance) return;
    
    instance.editor.updateOptions({ readOnly: isReadOnly });
    instance.readOnly = isReadOnly;
}

/**
 * Check if an editor is read-only
 * @param {string} editorId - Editor instance ID
 * @returns {boolean} True if read-only
 */
export function isEditorReadOnly(editorId) {
    const instance = editors.get(editorId);
    return instance ? !!instance.readOnly : false;
}
