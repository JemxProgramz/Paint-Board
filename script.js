"use strict";

import './style.css';
import './flaticon-icons.css';
import { scaleBitmap, transformBitmap, trimSelectionMask, drawMaskOutline, bindBitmapHandles, bitmapBlob } from './paint-bitmaps.js';
import { exportPaintFile, decodeTiff } from './classic-formats.js';
import './paint-tools.css';
import { BRUSHES, SHAPES, createStroke, curvePath, paintShape, paintTable, polygonPath, shapePath, snapLine, tableCellLayout } from './paint-tools.js';
import { makeCanvas, newLayer, validSize, transformedSize, resizeBitmap, boardSnapshot, restoreLayers, readProjectBoards } from './paint-document.js';
/**
 * @license
 * PaintBoard - Digital Whiteboard & Classic Desktop Drawing Application
 * Complete Vanilla JavaScript Implementation
 */

// =============================================================================
// 1. CONSTANTS & DEFAULT CONFIGURATION
// =============================================================================
const STORAGE_KEY_BOARDS = 'paintboard_boards_v1';
const STORAGE_KEY_ACTIVE = 'paintboard_active_id_v1';

const DEFAULT_CANVAS_WIDTH = 1600;
const DEFAULT_CANVAS_HEIGHT = 900;
const DEFAULT_CANVAS_BG = '#ffffff';

const PALETTE_COLORS = [
  '#000000', '#555555', '#888888', '#ffffff',
  '#780000', '#c1121f', '#f77f00', '#fcbf49',
  '#2a9d8f', '#38b000', '#0077b6', '#00b4d8',
  '#4361ee', '#7209b7', '#f72585', '#ff70a6',
  '#6f4e37', '#b08968', '#0f172a', '#334155'
];

const ZOOM_STEPS = [0.01, 0.025, 0.05, 0.075, 0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const CANVAS_PADDING = 32;

// =============================================================================
// 2. APPLICATION STATE
// =============================================================================
const AppState = {
  // Boards
  boards: [],
  activeBoardId: null,

  // Tool & Stroke
  activeTool: 'pencil',
  primaryColor: '#000000',
  secondaryColor: '#ffffff',
  brushSize: 6,
  brushOpacity: 1.0,
  brushTip: 'round',
  shapeFillMode: 'stroke', // 'stroke', 'fill', 'both'
  outlineStyle: 'solid',
  fillStyle: 'solid',

  // Text Tool options
  textOptions: {
    fontFamily: 'Arial, sans-serif',
    fontSize: 24,
    bold: false,
    italic: false,
    underline: false,
    align: 'left'
  },

  // Viewport & Zoom
  zoom: 1.0,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStart: { x: 0, y: 0 },

  // Drawing Interaction State
  isDrawing: false,
  drawStartPos: { x: 0, y: 0 },
  lastDrawPos: { x: 0, y: 0 },

  // Polygon Tool State
  polygonVertices: [],

  // Selection & Clipboard
  selection: {
    active: false,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    imageData: null,
    isDragging: false,
    dragOffset: { x: 0, y: 0 },
    hasLifted: false
  },
  clipboardImageData: null,

  // Floating Imported Image
  floatingImage: null,

  // Autosave timer
  saveTimeout: null,
  isSaving: false
};

// Per-board History Stacks: { [boardId]: { undo: [snapshotURL], redo: [snapshotURL] } }
const BoardHistories = Object.create(null);

// =============================================================================
// 3. STORAGE MANAGER
// =============================================================================
const StorageManager = {
  loadBoards() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_BOARDS);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        return readProjectBoards(data);
      }
      return null;
    } catch (e) {
      console.error('Failed to load boards from localStorage:', e);
      ToastManager.show('Recovering corrupted workspace data...', 'warn');
      return null;
    }
  },

  loadActiveId() {
    try {
      return localStorage.getItem(STORAGE_KEY_ACTIVE);
    } catch (e) {
      return null;
    }
  },

  saveBoards(boards, activeId) {
    try {
      localStorage.setItem(STORAGE_KEY_BOARDS, JSON.stringify(boards));
      if (activeId) localStorage.setItem(STORAGE_KEY_ACTIVE, activeId);
      return true;
    } catch (e) {
      ToastManager.show('Storage quota warning. Consider exporting project.', 'warn');
      return false;
    }
  },

  exportProjectJSON() {
    if (typeof BoardManager !== 'undefined') BoardManager.saveCurrentBoardState();
    
    const payload = {
      version: '2.0',
      timestamp: new Date().toISOString(),
      activeBoardId: AppState.activeBoardId,
      boards: AppState.boards
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PaintBoard_Project_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    ToastManager.show('Project exported to JSON', 'success');
  },

  importProjectJSON(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        const boards = readProjectBoards(data.boards);
        for (const board of boards) {
          for (const layer of board.layers) {
            if (!layer.png) continue;
            const img = new Image();
            img.src = layer.png;
            await img.decode();
            if (img.width !== board.width || img.height !== board.height) throw new Error('Incorrect layer dimensions');
          }
        }
        clearTimeout(AppState.saveTimeout);
        for (const key of Object.keys(BoardHistories)) delete BoardHistories[key];
        AppState.boards = boards;
        AppState.activeBoardId = boards.find(b => b.id === data.activeBoardId)?.id || boards[0].id;
        StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);
        BoardManager.renderBoardList();
        BoardManager.loadBoard(AppState.activeBoardId);
        ToastManager.show(`Project imported (${data.boards.length} boards)`, 'success');
      } catch (err) {
        console.error('Import failed:', err);
        ToastManager.show('Failed to import project file: invalid JSON', 'danger');
      }
    };
    reader.readAsText(file);
  }
};

// =============================================================================
// 4. TOAST NOTIFICATIONS & MODALS
// =============================================================================
const ToastManager = {
  container: null,

  init() {
    this.container = document.getElementById('toastContainer');
  },

  show(message, type = 'info', duration = 2800) {
    if (!this.container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    this.container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }
};

const ModalManager = {
  confirmCallback: null,

  showConfirm(title, message, subtext, confirmBtnText, onConfirm, isDanger = true) {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;
    document.getElementById('confirmModalSubtext').textContent = subtext || '';

    const actionBtn = document.getElementById('btnConfirmAction');
    actionBtn.textContent = confirmBtnText || 'Proceed';
    actionBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';

    this.confirmCallback = onConfirm;
    modal.showModal();
  },

  closeConfirm() {
    document.getElementById('confirmModal').close();
    this.confirmCallback = null;
  },

  showClearCanvas(board, opener) {
    if (!board) return;
    opener.focus({ preventScroll: true });
    this.showConfirm(
      'Clear canvas?',
      `This will erase the drawing on “${board.name}”.`,
      board.id === AppState.activeBoardId ? 'You can undo this.' : '',
      'Clear canvas',
      () => BoardManager.clearBoard(board.id)
    );
  },

  showRename(board) {
    const modal = document.getElementById('renameModal');
    const input = document.getElementById('renameBoardInput');
    input.value = board.name;
    modal.showModal();
    input.select();
  },

  closeRename() {
    document.getElementById('renameModal').close();
  },

  showResize() {
    const current = BoardManager.getActiveBoard();
    if (!current) return;
    const selection = SelectionManager.getSelectionBounds?.();
    const modal = document.getElementById('resizeCanvasModal');
    const widthInput = document.getElementById('resizeWidthInput');
    const heightInput = document.getElementById('resizeHeightInput');
    widthInput.value = selection?.w ?? current.width;
    heightInput.value = selection?.h ?? current.height;
    modal.dataset.width = widthInput.value;
    modal.dataset.height = heightInput.value;
    document.getElementById('resizeUnits').value = 'px';
    document.getElementById('skewX').value = 0;
    document.getElementById('skewY').value = 0;
    const scale = document.getElementById('resizeScaleContent');
    scale.checked = Boolean(selection) || document.getElementById('resizeUnits').value === 'percent';
    scale.disabled = Boolean(selection);
    modal.showModal();
  },

  closeResize() {
    document.getElementById('resizeCanvasModal').close();
  },

  showInsertTable(opener) {
    opener.focus({ preventScroll: true });
    document.getElementById('insertTableModal').showModal();
  },

  showShortcuts() {
    document.getElementById('shortcutsModal').showModal();
  },

  closeShortcuts() {
    document.getElementById('shortcutsModal').close();
  },

  showAbout() {
    document.getElementById('aboutModal').showModal();
  },

  closeAbout() {
    document.getElementById('aboutModal').close();
  }
};

// =============================================================================
// 5. HISTORY MANAGER (Undo / Redo per Board)
// =============================================================================
const HistoryManager = {
  maxSnapshots: 25,

  getHistory(boardId) {
    if (!BoardHistories[boardId]) {
      BoardHistories[boardId] = { undo: [], redo: [] };
    }
    return BoardHistories[boardId];
  },

  pushSnapshot(boardId, pixelsChanged = true) {
    if (!CanvasManager.ready || boardId !== AppState.activeBoardId) return;
    const history = this.getHistory(boardId);
    if (pixelsChanged) CanvasManager.activeLayer.png = undefined;
    const snapshot = CanvasManager.snapshot();

    history.undo.push(snapshot);
    if (history.undo.length > this.maxSnapshots) {
      history.undo.shift();
    }
    // Clear redo on new action
    history.redo = [];

    this.updateUndoRedoButtons();
    BoardManager.triggerAutosave();
  },

  undo() {
    const board = BoardManager.getActiveBoard();
    if (!board || !CanvasManager.ready) return;
    CanvasManager.finishEditing();
    const history = this.getHistory(board.id);
    if (history.undo.length <= 1) {
      ToastManager.show('Nothing to undo', 'info', 1500);
      return;
    }

    const currentSnapshot = history.undo.pop();
    history.redo.push(currentSnapshot);

    const previousSnapshot = history.undo[history.undo.length - 1];
    Object.assign(board, previousSnapshot);
    CanvasManager.restore(previousSnapshot, () => {
      this.updateUndoRedoButtons();
      BoardManager.triggerAutosave();
    });
  },

  redo() {
    const board = BoardManager.getActiveBoard();
    if (!board || !CanvasManager.ready) return;
    CanvasManager.finishEditing();
    const history = this.getHistory(board.id);
    if (history.redo.length === 0) {
      ToastManager.show('Nothing to redo', 'info', 1500);
      return;
    }

    const nextSnapshot = history.redo.pop();
    history.undo.push(nextSnapshot);

    Object.assign(board, nextSnapshot);
    CanvasManager.restore(nextSnapshot, () => {
      this.updateUndoRedoButtons();
      BoardManager.triggerAutosave();
    });
  },

  updateUndoRedoButtons() {
    const board = BoardManager.getActiveBoard();
    if (!board) return;
    const history = this.getHistory(board.id);

    const canUndo = history.undo.length > 1;
    const canRedo = history.redo.length > 0;

    const btnUndo = document.getElementById('btnUndoQuick');
    const btnRedo = document.getElementById('btnRedoQuick');
    const menuUndo = document.getElementById('menuItemUndo');
    const menuRedo = document.getElementById('menuItemRedo');

    if (btnUndo) btnUndo.style.opacity = canUndo ? '1' : '0.4';
    if (btnRedo) btnRedo.style.opacity = canRedo ? '1' : '0.4';
    if (menuUndo) menuUndo.style.opacity = canUndo ? '1' : '0.4';
    if (menuRedo) menuRedo.style.opacity = canRedo ? '1' : '0.4';
  }
};

// =============================================================================
// 6. BOARD MANAGER (Multi-Board System)
// =============================================================================
const BoardManager = {
  init() {
    const savedBoards = StorageManager.loadBoards();
    const savedActiveId = StorageManager.loadActiveId();

    if (savedBoards && savedBoards.length > 0) {
      AppState.boards = savedBoards;
      const targetId = (savedActiveId && savedBoards.find(b => b.id === savedActiveId))
        ? savedActiveId
        : savedBoards[0].id;
      AppState.activeBoardId = targetId;
    } else {
      // First start experience: Create Whiteboard 1
      const initialBoard = this.createBoardObject('Whiteboard 1');
      AppState.boards = [initialBoard];
      AppState.activeBoardId = initialBoard.id;
      StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);
    }

    this.renderBoardList();
    this.loadBoard(AppState.activeBoardId, true);
  },

  createBoardObject(name = 'Whiteboard 1', width = DEFAULT_CANVAS_WIDTH, height = DEFAULT_CANVAS_HEIGHT, background = DEFAULT_CANVAS_BG) {
    const id = 'board_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const now = new Date().toISOString();
    return {
      id,
      name,
      width,
      height,
      background,
      createdAt: now,
      updatedAt: now,
      canvasData: null,
      thumbnail: null
    };
  },

  getActiveBoard() {
    return AppState.boards.find(b => b.id === AppState.activeBoardId);
  },

  createNewBoard() {
    // 1. Save current board first
    TableEditor.finish();
    this.saveCurrentBoardState();

    // 2. Count existing whiteboards to suggest default name
    const count = AppState.boards.length + 1;
    const newBoard = this.createBoardObject(`Whiteboard ${count}`);
    AppState.boards.push(newBoard);
    AppState.activeBoardId = newBoard.id;

    this.renderBoardList();
    this.loadBoard(newBoard.id, true);
    ToastManager.show(`Created "${newBoard.name}"`, 'success');
  },

  openImage(name, image) {
    if (!validSize(image.naturalWidth, image.naturalHeight)) {
      ToastManager.show('Images can be up to 8000 pixels on each side.', 'warn');
      return;
    }
    TableEditor.finish();
    this.saveCurrentBoardState();
    const board = this.createBoardObject(name, image.naturalWidth, image.naturalHeight, 'transparent');
    AppState.boards.push(board);
    AppState.activeBoardId = board.id;
    this.loadBoard(board.id);
    CanvasManager.mainCtx.drawImage(image, 0, 0);
    CanvasManager.activeLayer.png = undefined;
    HistoryManager.getHistory(board.id).undo = [CanvasManager.snapshot()];
    CanvasManager.fitToWindow();
    this.saveCurrentBoardState();
    ToastManager.show(`Opened ${name}`, 'success');
  },

  switchBoard(targetId) {
    if (targetId === AppState.activeBoardId) return;

    // 1. Save current board
    TableEditor.finish();
    this.saveCurrentBoardState();
    
    // Clear DOM nodes for previous board
    if (typeof TextManager !== 'undefined') TextManager.clearAll();

    // 2. Switch active pointer
    AppState.activeBoardId = targetId;

    // 3. Render and load
    this.renderBoardList();
    this.loadBoard(targetId);
    ToastManager.show(`Switched to "${this.getActiveBoard().name}"`, 'info', 1500);
  },

  saveCurrentBoardState() {
    const board = this.getActiveBoard();
    if (!board) return;

    if (!CanvasManager.ready || CanvasManager.boardId !== board.id) return false;
    Object.assign(board, CanvasManager.snapshot());
    delete board.canvasData;
    board.thumbnail = CanvasManager.generateThumbnail(76, 52);
    board.updatedAt = new Date().toISOString();

    const saved = StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);
    this.updateBoardCardInList(board.id);
    return saved;
  },

  loadBoard(boardId, isNew = false) {
    const board = AppState.boards.find(b => b.id === boardId);
    if (!board) return;

    // Update Header and Status
    const headerName = document.getElementById('headerBoardName');
    if (headerName) headerName.textContent = board.name;
    document.getElementById('statusCanvasDimensions').textContent = `${board.width} × ${board.height} px`;

    CanvasManager.restore(boardSnapshot(board), () => {
      const history = HistoryManager.getHistory(board.id);
      if (!history.undo.length) history.undo.push(CanvasManager.snapshot());
      HistoryManager.updateUndoRedoButtons();
      StorageManager.saveBoards(AppState.boards, boardId);
    });

    this.renderBoardList();
  },

  renameBoard(boardId, newName) {
    const cleanName = newName.trim();
    if (!cleanName) return;

    const board = AppState.boards.find(b => b.id === boardId);
    if (!board) return;

    board.name = cleanName;
    board.updatedAt = new Date().toISOString();
    StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);

    if (board.id === AppState.activeBoardId) {
      const headerName = document.getElementById('headerBoardName');
      if (headerName) headerName.textContent = cleanName;
    }

    this.renderBoardList();
    ToastManager.show(`Renamed to "${cleanName}"`, 'success');
  },

  duplicateBoard(boardId) {
    const source = AppState.boards.find(b => b.id === boardId);
    if (!source) return;

    // Save active board first if duplicating
    TableEditor.finish();
    this.saveCurrentBoardState();

    const duplicated = {
      ...source,
      id: 'board_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: `${source.name} Copy`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    AppState.boards.push(duplicated);
    AppState.activeBoardId = duplicated.id;

    StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);
    this.renderBoardList();
    this.loadBoard(duplicated.id);
    ToastManager.show(`Duplicated "${source.name}"`, 'success');
  },

  clearBoard(boardId) {
    const board = AppState.boards.find(b => b.id === boardId);
    if (!board) return;

    if (board.id === AppState.activeBoardId) {
      if (!CanvasManager.ready) return;
      CanvasManager.finishEditing();
      CanvasManager.resetEditing();
      CanvasManager.layers = CanvasManager.layers.filter(layer => !layer.table && !layer.tableBitmap);
      CanvasManager.mountLayers();
      for (const layer of CanvasManager.layers) {
        layer.canvas.getContext('2d').clearRect(0, 0, board.width, board.height);
        layer.png = null;
      }
      HistoryManager.pushSnapshot(board.id, false);
    } else {
      board.canvasData = null;
      if (board.layers) board.layers = board.layers.filter(layer => !layer.table && !layer.tableBitmap).map(layer => ({ ...layer, png: null }));
      delete BoardHistories[board.id];
      board.thumbnail = null;
      board.updatedAt = new Date().toISOString();
      StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);
      this.renderBoardList();
    }
    ToastManager.show(`Cleared "${board.name}"`, 'info');
  },

  deleteBoard(boardId) {
    const index = AppState.boards.findIndex(b => b.id === boardId);
    if (index === -1) return;

    if (AppState.activeBoardId !== boardId) this.saveCurrentBoardState();

    const boardName = AppState.boards[index].name;
    AppState.boards.splice(index, 1);
    delete BoardHistories[boardId];

    // Safety rule: Never leave 0 boards
    if (AppState.boards.length === 0) {
      const fallback = this.createBoardObject('Whiteboard 1');
      AppState.boards = [fallback];
      AppState.activeBoardId = fallback.id;
    } else if (AppState.activeBoardId === boardId) {
      // Pick adjacent board
      const nextIndex = Math.max(0, index - 1);
      AppState.activeBoardId = AppState.boards[nextIndex].id;
    }

    StorageManager.saveBoards(AppState.boards, AppState.activeBoardId);
    this.renderBoardList();
    this.loadBoard(AppState.activeBoardId);
    ToastManager.show(`Deleted "${boardName}"`, 'info');
  },

  triggerAutosave() {
    AppState.isSaving = true;
    const indicator = document.getElementById('saveStatusIndicator');
    const statusText = document.getElementById('saveStatusText');
    indicator.dataset.state = 'saving';
    indicator.title = 'Saving in this browser';
    statusText.textContent = 'Saving…';

    clearTimeout(AppState.saveTimeout);
    AppState.saveTimeout = setTimeout(() => {
      const saved = this.saveCurrentBoardState();
      AppState.isSaving = false;
      indicator.dataset.state = saved ? 'saved' : 'unsaved';
      indicator.title = saved ? 'Saved in this browser' : 'Use File → Save project to make a backup.';
      statusText.textContent = saved ? 'Saved' : 'Unsaved';
    }, 450);
  },

  renderBoardList() {
    const container = document.getElementById('boardsListContainer');
    if (!container) return;
    container.innerHTML = '';
    document.querySelectorAll('body > .board-context-menu').forEach(m => m.remove());

    AppState.boards.forEach(board => {
      const isActive = board.id === AppState.activeBoardId;
      const card = document.createElement('div');
      card.className = `board-card ${isActive ? 'active' : ''}`;
      card.id = `board-card-${board.id}`;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      if (isActive) card.setAttribute('aria-current', 'true');

      const updatedTimeStr = this.formatRelativeTime(board.updatedAt);

      card.innerHTML = `
        <div class="board-thumb-box" aria-hidden="true">
          ${board.thumbnail ? `<img src="${board.thumbnail}" class="board-thumb-img" alt="">` : ''}
        </div>
        <div class="board-info">
          <span class="board-name-text" title="${this.escapeHTML(board.name)}">${this.escapeHTML(board.name)}</span>
          <span class="board-meta-text">${updatedTimeStr}</span>
        </div>
        <div class="board-actions">
          <button class="board-more-btn" data-id="${board.id}" title="Board Options" aria-label="Board Options"><span class="ui-icon ui-icon-menu-dots-vertical" aria-hidden="true"></span></button>
          <div class="board-context-menu dropdown-panel" id="menu-${board.id}">
            <button data-action="open" data-id="${board.id}" class="dropdown-item">
              <span class="item-label" data-action="open" data-id="${board.id}">Open Board</span>
            </button>
            <button data-action="rename" data-id="${board.id}" class="dropdown-item">
              <span class="item-label" data-action="rename" data-id="${board.id}">Rename...</span>
            </button>
            <button data-action="duplicate" data-id="${board.id}" class="dropdown-item">
              <span class="item-label" data-action="duplicate" data-id="${board.id}">Duplicate</span>
            </button>
            <div class="dropdown-separator"></div>
            <button data-action="clear" data-id="${board.id}" class="dropdown-item">
              <span class="item-label" data-action="clear" data-id="${board.id}">Clear Canvas</span>
            </button>
            <button data-action="delete" data-id="${board.id}" class="dropdown-item danger-item" style="color: var(--text-danger)">
              <span class="item-label" data-action="delete" data-id="${board.id}">Delete Board</span>
            </button>
          </div>
        </div>
      `;

      // Click card to open/switch
      card.addEventListener('click', (e) => {
        if (e.target.closest('.board-actions')) return;
        this.switchBoard(board.id);
      });

      // Context menu trigger
      const moreBtn = card.querySelector('.board-more-btn');
      const menu = card.querySelector('.board-context-menu');
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close others
        document.querySelectorAll('.board-context-menu.show').forEach(m => {
          if (m !== menu) m.classList.remove('show');
        });
        
        if (!menu.classList.contains('show')) {
          document.body.appendChild(menu);
          menu.style.position = 'fixed';
          menu.style.zIndex = '99999';
          menu.classList.add('show');
          
          const rect = moreBtn.getBoundingClientRect();
          const spaceBelow = window.innerHeight - rect.bottom - 8;
          menu.style.maxHeight = Math.max(spaceBelow, rect.top - 8) + 'px';
          menu.style.top = (menu.offsetHeight <= spaceBelow ? rect.bottom : Math.max(8, rect.top - menu.offsetHeight)) + 'px';
          menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
          menu.style.right = 'auto';
        } else {
          menu.classList.remove('show');
        }
      });

      // Context menu actions
      menu.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = e.target.dataset.action;
        const id = e.target.dataset.id;
        menu.classList.remove('show');

        if (action === 'open') {
          this.switchBoard(id);
        } else if (action === 'rename') {
          const target = AppState.boards.find(b => b.id === id);
          if (target) ModalManager.showRename(target);
        } else if (action === 'duplicate') {
          this.duplicateBoard(id);
        } else if (action === 'clear') {
          ModalManager.showClearCanvas(AppState.boards.find(b => b.id === id), moreBtn);
        } else if (action === 'delete') {
          const target = AppState.boards.find(b => b.id === id);
          if (target) {
            ModalManager.showConfirm(
              'Delete Board',
              `Delete "${target.name}"?`,
              'This will permanently delete this whiteboard.',
              'Delete',
              () => BoardManager.deleteBoard(id),
              true
            );
          }
        }
      });

      container.appendChild(card);
    });
  },

  updateBoardCardInList(boardId) {
    const board = AppState.boards.find(b => b.id === boardId);
    if (!board) return;
    const card = document.getElementById(`board-card-${boardId}`);
    if (!card) return;

    const thumbImg = card.querySelector('.board-thumb-box');
    if (thumbImg && board.thumbnail) {
      thumbImg.innerHTML = `<img src="${board.thumbnail}" class="board-thumb-img" alt="">`;
    }
    const meta = card.querySelector('.board-meta-text');
    if (meta) meta.textContent = this.formatRelativeTime(board.updatedAt);
  },

  formatRelativeTime(isoString) {
    if (!isoString) return 'Just now';
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  },

  escapeHTML(str) {
    return str.replace(/[&<>'"]/g,
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }
};

// =============================================================================
// 7. CANVAS MANAGER (Layers, Transforms, Grid, Coordinate Mapping)
// =============================================================================
const CanvasManager = {
  fitMode: true,
  layers: [],
  activeLayer: null,
  boardId: null,
  ready: false,
  restoreId: 0,
  viewport: null,
  transformContainer: null,
  artboard: null,
  mainCanvas: null,
  mainCtx: null,
  overlayCanvas: null,
  overlayCtx: null,
  gridLayer: null,

  init() {
    this.viewport = document.getElementById('canvasViewport');
    this.transformContainer = document.getElementById('canvasTransformContainer');
    this.artboard = document.getElementById('canvasArtboard');
    this.mainCanvas = document.getElementById('mainCanvas');
    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true });
    this.overlayCanvas = document.getElementById('overlayCanvas');
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.gridLayer = document.getElementById('gridLayer');
    this.laserPointer = document.getElementById('laserPointer');

    this.layerHost = document.getElementById('paintLayers');
    this.bindViewOptions();
    this.viewport.addEventListener('pointerdown', event => {
      if (!this.ready) event.stopImmediatePropagation();
    }, true);
    this.bindEvents();
  },

  canEdit() {
    return this.ready;
  },

  finishEditing() {
    TableEditor.finish();
    ToolManager.cancelPending?.();
    SelectionManager.deselect();
    TextManager.commit();
  },

  resetEditing() {
    TableEditor.finish(false);
    ToolManager.cancelPending?.();
    SelectionManager.reset?.();
    TextManager.clearAll();
    ImageManager.cancelImage();
    this.clearOverlay();
  },

  snapshot() {
    const width = this.mainCanvas.width;
    const height = this.mainCanvas.height;
    const layers = this.layers.map(layer => {
      let png = layer.png;
      if (layer === this.activeLayer && (TextManager.nodes.length || SelectionManager.floatingCanvas)) {
        const copy = makeCanvas(width, height);
        const ctx = copy.getContext('2d');
        ctx.drawImage(layer.canvas, 0, 0);
        SelectionManager.drawFloatingTo?.(ctx);
        TextManager.drawAllToCanvas(ctx);
        png = copy.toDataURL();
      } else if (png === undefined) {
        png = layer.png = layer.canvas.toDataURL();
      }
      return { id: layer.id, name: layer.name, visible: layer.visible, png,
        ...(layer.table && { table: layer.table }), ...(layer.tableBitmap && { tableBitmap: true }) };
    });
    return { width, height, background: BoardManager.getActiveBoard().background, activeLayerId: this.activeLayer.id, layers };
  },

  restore(snapshot, onReady) {
    const ticket = ++this.restoreId;
    this.ready = false;
    this.resetEditing();
    this.boardId = AppState.activeBoardId;
    this.artboard.setAttribute('aria-busy', 'true');
    const install = layers => {
      if (ticket !== this.restoreId) return;
      this.layers = layers;
      // Preserve imported layers. Draw on the top visible layer when the panel is absent.
      for (const layer of layers) {
        if (layer.table && !layer.png) this.drawTableLayer(layer);
      }
      this.activeLayer = layers.findLast(layer => layer.visible && !layer.table && !layer.tableBitmap);
      if (!this.activeLayer) {
        this.activeLayer = newLayer(snapshot.width, snapshot.height, 'Drawing');
        layers.push(this.activeLayer);
      }
      this.mountLayers();
      this.setDimensions(snapshot.width, snapshot.height);
      this.setBackground(snapshot.background, false);
      this.ready = true;
      this.artboard.removeAttribute('aria-busy');
      onReady?.();
    };
    if (snapshot.layers.every(layer => !layer.png)) {
      install(snapshot.layers.map(layer => ({ ...layer, canvas: makeCanvas(snapshot.width, snapshot.height) })));
    } else {
      restoreLayers(snapshot).then(install).catch(() => {
        if (ticket !== this.restoreId) return;
        this.artboard.removeAttribute('aria-busy');
        ToastManager.show('Could not open the saved image data. Your project backup is still available.', 'error');
      });
    }
  },

  mountLayers() {
    this.layers.forEach(layer => {
      layer.canvas.className = 'paint-layer';
      layer.canvas.id = layer === this.activeLayer ? 'mainCanvas' : '';
      layer.canvas.hidden = !layer.visible;
      layer.canvas.style.zIndex = '2';
    });
    this.layerHost.replaceChildren(...this.layers.map(layer => layer.canvas));
    this.mainCanvas = this.activeLayer.canvas;
    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true });
  },

  addTable(table) {
    const { width, height } = this.mainCanvas;
    const layer = newLayer(width, height, 'Table');
    layer.table = table;
    this.drawTableLayer(layer);
    // Keep the drawing layer above tables so pen marks can be edited independently.
    this.layers.splice(this.layers.indexOf(this.activeLayer), 0, layer);
    this.mountLayers();
    HistoryManager.pushSnapshot(this.boardId, false);
    return layer;
  },

  drawTableLayer(layer) {
    const ctx = layer.canvas.getContext('2d');
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    paintTable(ctx, layer.table);
    layer.png = undefined;
  },

  composite({ background = true, opaque = false } = {}) {
    const result = makeCanvas(this.mainCanvas.width, this.mainCanvas.height);
    const ctx = result.getContext('2d');
    const bg = BoardManager.getActiveBoard().background;
    if (opaque || (background && bg !== 'transparent')) {
      ctx.fillStyle = background && bg !== 'transparent' ? bg : '#ffffff';
      ctx.fillRect(0, 0, result.width, result.height);
    }
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      ctx.drawImage(layer.canvas, 0, 0);
      if (layer === this.activeLayer) {
        SelectionManager.drawFloatingTo?.(ctx);
        TextManager.drawAllToCanvas(ctx);
      }
    }
    return result;
  },

  setDimensions(width, height) {
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = height;

    this.artboard.style.width = `${width}px`;
    this.artboard.style.height = `${height}px`;
    document.getElementById('statusCanvasDimensions').textContent = `${width} × ${height} px`;
    if (this.fitMode) this.fitToWindow();
    else this.setZoom(AppState.zoom);
  },

  setBackground(bg, save = true) {
    const board = BoardManager.getActiveBoard();
    if (board && save && this.ready) {
      board.background = bg;
      HistoryManager.pushSnapshot(board.id, false);
    }

    if (bg === 'transparent') {
      this.artboard.style.backgroundColor = 'transparent';
      this.artboard.style.backgroundImage = 'repeating-conic-gradient(#e2e8f0 0% 25%, #ffffff 0% 50%)';
      this.artboard.style.backgroundSize = '16px 16px';
    } else {
      this.artboard.style.backgroundColor = bg;
      this.artboard.style.backgroundImage = 'none';
    }

    // Update active state in UI
    document.querySelectorAll('.bg-preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.bg === bg);
    });
  },

  clearMainCanvas() {
    this.mainCtx.clearRect(0, 0, this.mainCanvas.width, this.mainCanvas.height);
  },

  clearOverlay() {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  },

  generateThumbnail(w = 76, h = 52) {
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = w;
    thumbCanvas.height = h;
    const ctx = thumbCanvas.getContext('2d');

    const board = BoardManager.getActiveBoard();
    const bg = board ? board.background : DEFAULT_CANVAS_BG;

    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.drawImage(this.composite(), 0, 0, w, h);
    return thumbCanvas.toDataURL('image/jpeg', 0.6);
  },

  getCanvasCoords(e) {
    const rect = this.artboard.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);

    const rawX = (clientX - rect.left) / AppState.zoom;
    const rawY = (clientY - rect.top) / AppState.zoom;

    return {
      x: Math.round(Math.max(0, Math.min(this.mainCanvas.width, rawX))),
      y: Math.round(Math.max(0, Math.min(this.mainCanvas.height, rawY))),
      pressure: e.pressure !== undefined ? e.pressure : 1
    };
  },

  setZoom(zoomFactor, fit = false) {
    this.fitMode = fit;
    const clamped = Math.min(8, Math.max(0.01, zoomFactor));
    AppState.zoom = clamped;

    this.transformContainer.style.width = `max(100%, ${Math.round(this.mainCanvas.width * clamped) + CANVAS_PADDING}px)`;
    this.transformContainer.style.height = `max(100%, ${Math.round(this.mainCanvas.height * clamped) + CANVAS_PADDING}px)`;
    this.artboard.style.transform = `translate(-50%, -50%) scale(${clamped})`;
    this.artboard.style.setProperty('--inverse-zoom', 1 / clamped);
    this.artboard.classList.toggle('pixel-zoom', clamped >= 1);
    document.getElementById('statusZoomLevel').textContent = `${Math.round(clamped * 100)}%`;
    document.getElementById('btnFitWindowQuick').setAttribute('aria-pressed', String(fit));
    this.drawRulers();
  },

  zoomIn() {
    const next = ZOOM_STEPS.find(s => s > AppState.zoom + 0.001) || 8;
    this.setZoom(next);
  },

  zoomOut() {
    const prev = [...ZOOM_STEPS].reverse().find(s => s < AppState.zoom - 0.001) || ZOOM_STEPS[0];
    this.setZoom(prev);
  },

  resetZoom() {
    this.setZoom(1.0);
  },

  fitToWindow() {
    const scaleW = (this.viewport.clientWidth - CANVAS_PADDING) / this.mainCanvas.width;
    const scaleH = (this.viewport.clientHeight - CANVAS_PADDING) / this.mainCanvas.height;
    this.setZoom(Math.min(1.5, scaleW, scaleH), true);
    this.viewport.scrollTo(0, 0);
  },

  toggleGuide(button) {
    const guide = button.dataset.guide;
    const nextGuide = this.gridLayer.dataset.guide === guide ? '' : guide;
    this.gridLayer.dataset.guide = nextGuide;
    document.querySelectorAll('button[data-guide]').forEach(option => {
      option.setAttribute('aria-pressed', String(option.dataset.guide === nextGuide));
    });
    ToastManager.show(`${button.textContent.trim()} ${nextGuide ? 'enabled' : 'disabled'}`, 'info', 1500);
  },

  setGridSpacing(spacing) {
    this.gridLayer.style.setProperty('--grid-spacing', `${spacing}px`);
  },

  bindViewOptions() {
    const toggle = document.getElementById('toggleRulers');
    toggle.addEventListener('click', () => {
      this.showRulers = !this.showRulers;
      toggle.setAttribute('aria-pressed', String(this.showRulers));
      document.querySelectorAll('.paint-ruler').forEach(ruler => ruler.hidden = !this.showRulers);
      this.drawRulers();
    });
    this.viewport.addEventListener('scroll', () => this.drawRulers(), { passive: true });
    new ResizeObserver(() => {
      if (this.fitMode && this.ready && ToolManager.pointerId === null) this.fitToWindow();
      else this.drawRulers();
    }).observe(this.viewport);
    document.getElementById('viewFullScreen').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { ToastManager.show('Use your browser’s full-screen command.', 'info'); }
    });
  },

  drawRulers() {
    if (!this.showRulers) return;
    const board = this.artboard.getBoundingClientRect();
    const viewport = this.viewport.getBoundingClientRect();
    const zoom = AppState.zoom;
    const step = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000].find(n => n * zoom >= 45);
    for (const vertical of [false, true]) {
      const ruler = document.getElementById(vertical ? 'verticalRuler' : 'horizontalRuler');
      const length = Math.max(1, (vertical ? this.viewport.clientHeight : this.viewport.clientWidth) - 18);
      const start = (vertical ? board.top - viewport.top : board.left - viewport.left) - 18;
      ruler.width = vertical ? 18 : length;
      ruler.height = vertical ? length : 18;
      const ctx = ruler.getContext('2d');
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, ruler.width, ruler.height);
      if (vertical) { ctx.translate(18, 0); ctx.rotate(Math.PI / 2); }
      ctx.fillStyle = '#334155';
      ctx.font = '10px sans-serif';
      const limit = vertical ? this.mainCanvas.height : this.mainCanvas.width;
      for (let n = 0; n <= limit; n += step / 5) {
        const x = Math.round(start + n * zoom);
        if (x < 0 || x > length) continue;
        const major = n % step === 0;
        ctx.fillRect(x, vertical ? 0 : major ? 10 : 14, 1, major ? 8 : 4);
        if (major) ctx.fillText(String(n), x + 2, vertical ? 16 : 10);
      }
    }
  },

  // Image Transformations
  transformLayers(transform) {
    if (!this.ready) return;
    this.finishEditing();
    // Build all outputs before replacing any input (including hidden layers).
    const canvases = this.layers.map(layer => transform(layer.canvas));
    this.layers.forEach((layer, i) => {
      layer.canvas = canvases[i];
      layer.png = undefined;
      // ponytail: bitmap transforms preserve the artwork and bake in editable tables.
      if (layer.table) {
        delete layer.table;
        layer.tableBitmap = true;
      }
    });
    this.mountLayers();
    const { width, height } = this.mainCanvas;
    Object.assign(BoardManager.getActiveBoard(), { width, height });
    this.setDimensions(width, height);
    HistoryManager.pushSnapshot(this.boardId, false);
  },

  applyTransform(operation) {
    if (!this.ready || SelectionManager.transformFloating?.(operation)) return;
    if (operation === 'invert') {
      const board = BoardManager.getActiveBoard();
      if (board.background !== 'transparent') {
        board.background = '#' + (0xffffff ^ parseInt(board.background.slice(1), 16)).toString(16).padStart(6, '0');
        this.setBackground(board.background, false);
      }
    }
    this.transformLayers(canvas => transformBitmap(canvas, canvas.width, canvas.height, operation));
  },

  rotateCanvas(degrees) {
    this.applyTransform('rotate' + ((degrees + 360) % 360));
  },

  flipCanvas(horizontal) {
    this.applyTransform(horizontal ? 'flipH' : 'flipV');
  },

  crop() {
    if (!this.ready) return;
    const bounds = SelectionManager.getSelectionBounds?.();
    if (!bounds) {
      ToastManager.show('Select the area to keep, then choose Crop.', 'info');
      return;
    }
    const x = Math.max(0, bounds.x);
    const y = Math.max(0, bounds.y);
    const w = Math.min(this.mainCanvas.width, bounds.x + bounds.w) - x;
    const h = Math.min(this.mainCanvas.height, bounds.y + bounds.h) - y;
    if (w < 1 || h < 1) return;
    this.transformLayers(source => {
      const result = makeCanvas(w, h);
      result.getContext('2d').drawImage(source, -x, -y);
      return result;
    });
  },

  resizeCanvas(width, height, scaleContent, skewX = 0, skewY = 0) {
    if (!this.ready) return;
    if (SelectionManager.resizeFloating?.(width, height, skewX, skewY)) return;
    this.transformLayers(canvas => resizeBitmap(canvas, width, height, scaleContent, skewX, skewY));
  },

  bindEvents() {
    // Pointer Events on Viewport / Canvas
    this.viewport.addEventListener('pointerdown', (e) => ToolManager.onPointerDown(e));
    window.addEventListener('pointermove', (e) => ToolManager.onPointerMove(e));
    window.addEventListener('pointerup', (e) => ToolManager.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => ToolManager.onPointerCancel(e));
    this.viewport.addEventListener('lostpointercapture', (e) => ToolManager.onPointerCancel(e));
    this.artboard.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
    });
    window.addEventListener('blur', () => {
      if (ToolManager.pointerId !== null) ToolManager.cancelPending();
      this.viewport.classList.toggle('tool-pan', AppState.activeTool === 'pan');
    });

    // Mouse Wheel Zoom
    this.viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
    }, { passive: false });

    // Drag & Drop Image Files onto Canvas
    this.viewport.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    this.viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = e.dataTransfer.files;
      if (files && files.length > 0 && files[0].type.startsWith('image/')) {
        ImageManager.handleImageFile(files[0]);
      }
    });

    // Double-click to close polygon
    this.artboard.addEventListener('dblclick', (e) => {
      if (AppState.activeTool === 'polygon') {
        ToolManager.finishPolygon();
      }
    });
  }
};

// =============================================================================
// 8. TOOL MANAGER & DRAWING ENGINE
// =============================================================================
const ToolManager = {
  pointerId: null,
  stroke: null,
  eraserBase: null,
  sprayTimer: null,
  curve: null,
  table: null,
  reversed: false,

  setTool(tool) {
    const previous = AppState.activeTool;
    if (tool !== previous) {
      TableEditor.finish();
      if (!this.finishPending()) this.cancelPending();
      if (previous === 'text') TextManager.commit();
      if (previous === 'select') SelectionManager.deselect();
    }
    AppState.activeTool = tool;
    document.querySelectorAll('.tool-card').forEach(button => {
      const selected = button.dataset.tool === tool;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const shape = Object.hasOwn(SHAPES, tool);
    document.getElementById('shapeGallery').value = shape ? tool : '';
    const label = tool === 'laser' ? 'Laser pointer' : SHAPES[tool]?.[0] || tool.charAt(0).toUpperCase() + tool.slice(1);
    document.getElementById('statusActiveTool').textContent = label;
    const groups = {
      textOptionsGroup: tool === 'text',
      selectionOptionsGroup: tool === 'select',
      brushTipGroup: tool === 'brush',
      shapeOptionsGroup: shape,
      closedShapeOptions: shape && tool !== 'line' && tool !== 'curve'
    };
    for (const [id, visible] of Object.entries(groups)) {
      document.getElementById(id).style.display = visible ? 'flex' : 'none';
    }
    this.updateShapeHint();
    CanvasManager.viewport.classList.toggle('tool-pan', tool === 'pan');
    CanvasManager.viewport.classList.toggle('tool-magnifier', tool === 'magnifier');
  },

  updateShapeHint() {
    const help = document.getElementById('shapeToolHelp');
    if (AppState.activeTool === 'curve') {
      const bends = this.curve?.bends.length;
      help.textContent = bends === undefined ? 'Drag the endpoints, then place two bends.'
        : bends === 0 ? 'Place the first bend or press Enter to finish.'
        : 'Place the second bend or press Enter to finish.';
    } else if (AppState.activeTool === 'polygon') {
      help.textContent = 'Click each corner. Double-click or press Enter to close.';
    } else {
      help.textContent = '';
    }
    help.hidden = !help.textContent;
  },

  settings() {
    return {
      color: this.reversed ? AppState.secondaryColor : AppState.primaryColor,
      fillColor: this.reversed ? AppState.primaryColor : AppState.secondaryColor,
      size: AppState.brushSize, opacity: AppState.brushOpacity,
      mode: AppState.shapeFillMode, outlineStyle: AppState.outlineStyle, fillStyle: AppState.fillStyle
    };
  },

  point(event) {
    if (AppState.activeTool === 'select' || AppState.activeTool === 'table') {
      return CanvasManager.getCanvasCoords(event);
    }
    const canvas = CanvasManager.overlayCanvas;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height,
      pressure: event.pointerType === 'pen' ? Math.max(0.08, event.pressure || AppState.lastDrawPos.pressure || 0.5) : 1
    };
  },

  capture(event) {
    this.pointerId = event.pointerId;
    CanvasManager.viewport.setPointerCapture(event.pointerId);
  },

  release() {
    const id = this.pointerId;
    this.pointerId = null;
    AppState.isDrawing = false;
    AppState.isPanning = false;
    CanvasManager.viewport.classList.remove('tool-panning');
    if (AppState.activeTool === 'laser') CanvasManager.laserPointer.hidden = true;
    if (id !== null && CanvasManager.viewport.hasPointerCapture(id)) CanvasManager.viewport.releasePointerCapture(id);
  },

  onPointerDown(event) {
    if (this.pointerId !== null || event.isPrimary === false ||
        event.target.closest('button, input, textarea, [contenteditable="true"], .selection-handle, .floating-image-layer, .text-node')) return;
    const vp = CanvasManager.viewport;
    const tool = AppState.activeTool;
    if (tool === 'pan' || vp.classList.contains('tool-pan') || event.button === 1) {
      event.preventDefault();
      this.capture(event);
      AppState.isPanning = true;
      AppState.panStart = { x: event.clientX, y: event.clientY };
      vp.classList.add('tool-panning');
      return;
    }
    if (!CanvasManager.artboard.contains(event.target) || ![0, 2].includes(event.button)) return;
    event.preventDefault();
    vp.focus({ preventScroll: true });
    const pos = this.point(event);
    const secondary = event.button === 2 || (event.pointerType === 'mouse' && event.ctrlKey);
    if (!this.curve && !AppState.polygonVertices.length) this.reversed = secondary;
    const paint = this.settings();

    if (tool === 'fill' || tool === 'picker') {
      const x = Math.max(0, Math.min(CanvasManager.mainCanvas.width - 1, Math.floor(pos.x)));
      const y = Math.max(0, Math.min(CanvasManager.mainCanvas.height - 1, Math.floor(pos.y)));
      if (tool === 'fill') this.executeFloodFill(x, y, paint.color);
      else this.sampleColor(x, y, secondary || event.altKey);
      return;
    }
    if (tool === 'magnifier') {
      const out = secondary || event.altKey;
      if (out) CanvasManager.zoomOut();
      else CanvasManager.zoomIn();
      const bounds = CanvasManager.overlayCanvas.getBoundingClientRect();
      vp.scrollLeft += bounds.left + pos.x * bounds.width / CanvasManager.mainCanvas.width - event.clientX;
      vp.scrollTop += bounds.top + pos.y * bounds.height / CanvasManager.mainCanvas.height - event.clientY;
      return;
    }
    if (tool === 'text') {
      if (!TableEditor.openAt(pos)) TextManager.openEditor(pos.x, pos.y, paint.color);
      return;
    }
    if (tool === 'polygon') {
      this.addPolygonVertex(pos, event.shiftKey);
      return;
    }

    this.capture(event);
    AppState.isDrawing = true;
    AppState.drawStartPos = AppState.lastDrawPos = pos;
    if (tool === 'laser') {
      this.moveLaser(pos);
    } else if (tool === 'select') {
      SelectionManager.onPointerDown(event, pos);
    } else if (['brush', 'pencil', 'eraser'].includes(tool)) {
      const tip = tool === 'brush' ? AppState.brushTip : tool;
      const size = tool === 'eraser' ? paint.size * 2 : paint.size;
      CanvasManager.clearOverlay();
      if (tool === 'eraser') {
        const canvas = CanvasManager.mainCanvas;
        this.eraserBase = makeCanvas(canvas.width, canvas.height);
        this.eraserBase.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0);
        CanvasManager.overlayCanvas.style.visibility = 'hidden';
      }
      this.stroke = createStroke(CanvasManager.overlayCtx, { tip, size, color: paint.color }, pos);
      this.stroke.opacity *= paint.opacity;
      CanvasManager.overlayCanvas.style.opacity = this.stroke.opacity;
      if (this.eraserBase) this.eraseRegion(pos, pos);
      if (tip === 'airbrush') this.sprayTimer = window.setInterval(() => this.stroke.spray(), 60);
    } else if (tool === 'curve' && this.curve) {
      this.drawCurve(pos);
    }
  },

  onPointerMove(event) {
    if (event.isPrimary === false || (this.pointerId !== null && this.pointerId !== event.pointerId)) return;
    if (this.pointerId === null && !CanvasManager.artboard.contains(event.target)) return;
    if (AppState.isPanning) {
      CanvasManager.viewport.scrollLeft -= event.clientX - AppState.panStart.x;
      CanvasManager.viewport.scrollTop -= event.clientY - AppState.panStart.y;
      AppState.panStart = { x: event.clientX, y: event.clientY };
      return;
    }
    const pos = this.point(event);
    const coord = document.getElementById('statusCoordinates');
    coord.textContent = 'X: ' + Math.floor(pos.x) + ', Y: ' + Math.floor(pos.y);
    const tool = AppState.activeTool;
    if (tool === 'polygon' && AppState.polygonVertices.length) {
      const last = AppState.polygonVertices.at(-1);
      this.drawPolygon(event.shiftKey ? snapLine(last, pos) : pos);
    }
    if (!AppState.isDrawing) return;
    if (tool === 'laser') {
      this.moveLaser(pos);
    } else if (this.stroke) {
      for (const sample of event.getCoalescedEvents?.() || []) this.extendStroke(this.point(sample));
      this.extendStroke(pos);
    } else if (tool === 'select') {
      SelectionManager.onPointerMove(pos, event);
    } else if (tool === 'curve' && this.curve) {
      this.drawCurve(pos);
    } else if (tool === 'table') {
      CanvasManager.clearOverlay();
      const table = this.tableAt(pos);
      if (table) paintTable(CanvasManager.overlayCtx, table);
    } else if (Object.hasOwn(SHAPES, tool)) {
      CanvasManager.clearOverlay();
      this.drawDragShape(CanvasManager.overlayCtx, tool, pos, event.shiftKey);
    }
    AppState.lastDrawPos = pos;
  },

  extendStroke(pos) {
    const previous = AppState.lastDrawPos;
    if (previous.x === pos.x && previous.y === pos.y) return;
    this.stroke.add(pos);
    if (this.eraserBase) this.eraseRegion(previous, pos);
    AppState.lastDrawPos = pos;
  },

  moveLaser({ x, y }) {
    const { laserPointer, mainCanvas } = CanvasManager;
    laserPointer.hidden = x < 0 || y < 0 || x > mainCanvas.width || y > mainCanvas.height;
    laserPointer.style.left = `${x}px`;
    laserPointer.style.top = `${y}px`;
  },

  eraseRegion(a, b) {
    const ctx = CanvasManager.mainCtx;
    const pad = AppState.brushSize + 2;
    const x = Math.max(0, Math.floor(Math.min(a.x, b.x) - pad));
    const y = Math.max(0, Math.floor(Math.min(a.y, b.y) - pad));
    const w = Math.min(ctx.canvas.width, Math.ceil(Math.max(a.x, b.x) + pad)) - x;
    const h = Math.min(ctx.canvas.height, Math.ceil(Math.max(a.y, b.y) + pad)) - y;
    if (w <= 0 || h <= 0) return;
    if (this.reversed) {
      const original = this.eraserBase.getContext('2d').getImageData(x, y, w, h);
      const mask = CanvasManager.overlayCtx.getImageData(x, y, w, h).data;
      const source = this.hexToRGBA(AppState.primaryColor);
      const replacement = this.hexToRGBA(AppState.secondaryColor);
      const data = original.data;
      for (let i = 0; i < data.length; i += 4) {
        if (!data[i + 3] || data[i] !== source.r || data[i + 1] !== source.g || data[i + 2] !== source.b) continue;
        const coverage = mask[i + 3] / 255 * this.stroke.opacity;
        data[i] += (replacement.r - data[i]) * coverage;
        data[i + 1] += (replacement.g - data[i + 1]) * coverage;
        data[i + 2] += (replacement.b - data[i + 2]) * coverage;
      }
      ctx.putImageData(original, x, y);
    } else {
      ctx.save();
      ctx.clearRect(x, y, w, h);
      ctx.drawImage(this.eraserBase, x, y, w, h, x, y, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = this.stroke.opacity;
      ctx.drawImage(CanvasManager.overlayCanvas, x, y, w, h, x, y, w, h);
      ctx.restore();
    }
  },

  onPointerUp(event) {
    if (this.pointerId !== event.pointerId) return;
    if (AppState.isPanning) { this.release(); return; }
    const pos = this.point(event);
    const tool = AppState.activeTool;
    const ctx = CanvasManager.mainCtx;
    let changed = false;
    if (this.stroke) {
      this.extendStroke(pos);
      if (!this.eraserBase) {
        ctx.save();
        ctx.globalAlpha = this.stroke.opacity;
        ctx.drawImage(CanvasManager.overlayCanvas, 0, 0);
        ctx.restore();
      }
      this.clearStroke();
      changed = true;
    } else if (tool === 'select') {
      SelectionManager.onPointerMove(pos, event);
      SelectionManager.onPointerUp(pos, event);
    } else if (tool === 'curve') {
      if (this.curve) {
        this.curve.bends.push(pos);
      } else if (pos.x !== AppState.drawStartPos.x || pos.y !== AppState.drawStartPos.y) {
        const start = AppState.drawStartPos;
        this.curve = { start, end: event.shiftKey ? snapLine(start, pos) : pos, bends: [] };
      }
      this.release();
      if (this.curve?.bends.length === 2) this.finishPending();
      else if (this.curve) this.drawCurve();
      this.updateShapeHint();
      return;
    } else if (tool === 'table') {
      CanvasManager.clearOverlay();
      const table = this.tableAt(pos);
      this.release();
      if (!table) {
        ToastManager.show('Drag a larger area to fit the table cells.', 'info');
        return;
      }
      const layer = CanvasManager.addTable(table);
      this.setTool('text');
      TableEditor.open(layer, 0);
      return;
    } else if (Object.hasOwn(SHAPES, tool)) {
      CanvasManager.clearOverlay();
      if (pos.x !== AppState.drawStartPos.x || pos.y !== AppState.drawStartPos.y) {
        this.drawDragShape(ctx, tool, pos, event.shiftKey);
        changed = true;
      }
    }
    this.release();
    if (changed) HistoryManager.pushSnapshot(AppState.activeBoardId);
  },

  drawDragShape(ctx, tool, end, constrained) {
    const start = AppState.drawStartPos;
    const open = tool === 'line' || tool === 'curve';
    const path = shapePath(open ? 'line' : tool, start, end, constrained);
    paintShape(ctx, path, this.settings(), { open, start, end });
  },

  tableAt(end) {
    const start = AppState.drawStartPos;
    const { rows, columns } = this.table;
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < columns * 8 || height < rows * 10) return null;
    const { color, opacity } = this.settings();
    const { fontFamily } = AppState.textOptions;
    const fontSize = Math.min(64, Math.max(AppState.textOptions.fontSize, Math.ceil(12 / AppState.zoom)));
    const borderWidth = Math.min(8, Math.max(2, Math.ceil(1.5 / AppState.zoom)));
    return {
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width, height, rows, columns, color, opacity, fontFamily, fontSize, borderWidth,
      cells: Array(rows * columns).fill('')
    };
  },

  clearStroke() {
    window.clearInterval(this.sprayTimer);
    this.sprayTimer = this.stroke = this.eraserBase = null;
    CanvasManager.overlayCanvas.style.removeProperty('opacity');
    CanvasManager.overlayCanvas.style.removeProperty('visibility');
    CanvasManager.clearOverlay();
  },

  onPointerCancel(event) {
    if (this.pointerId === event.pointerId) this.cancelPending();
  },

  cancelPending() {
    const pending = this.pointerId !== null || !!this.curve || AppState.polygonVertices.length > 0;
    if (!pending) return false;
    if (AppState.isDrawing && AppState.activeTool === 'select') SelectionManager.cancelGesture();
    if (this.eraserBase) {
      CanvasManager.clearMainCanvas();
      CanvasManager.mainCtx.drawImage(this.eraserBase, 0, 0);
    }
    this.clearStroke();
    this.curve = null;
    AppState.polygonVertices = [];
    this.release();
    this.updateShapeHint();
    return true;
  },

  drawCurve(candidate) {
    const { start, end, bends } = this.curve;
    CanvasManager.clearOverlay();
    const path = curvePath(start, end, candidate ? [...bends, candidate] : bends);
    paintShape(CanvasManager.overlayCtx, path, this.settings(), { open: true });
  },

  addPolygonVertex(pos, constrained) {
    const vertices = AppState.polygonVertices;
    const last = vertices.at(-1);
    if (vertices.length >= 3 && Math.hypot(pos.x - vertices[0].x, pos.y - vertices[0].y) * AppState.zoom < 6) {
      this.finishPending();
      return;
    }
    if (last && Math.hypot(pos.x - last.x, pos.y - last.y) < 0.5) return;
    vertices.push(constrained && last ? snapLine(last, pos) : pos);
    this.drawPolygon();
  },

  drawPolygon(candidate) {
    const vertices = candidate ? [...AppState.polygonVertices, candidate] : AppState.polygonVertices;
    CanvasManager.clearOverlay();
    paintShape(CanvasManager.overlayCtx, polygonPath(vertices, vertices.length >= 3), this.settings(),
      { open: vertices.length < 3, start: vertices[0], end: vertices.at(-1) });
  },

  finishPending() {
    let path, style;
    if (this.curve) {
      const { start, end, bends } = this.curve;
      path = curvePath(start, end, bends);
      style = { open: true };
    } else if (AppState.polygonVertices.length) {
      const vertices = AppState.polygonVertices;
      if (vertices.length < 3) return this.cancelPending();
      path = polygonPath(vertices, true);
      style = { start: vertices[0], end: vertices.at(-1) };
    } else return false;
    paintShape(CanvasManager.mainCtx, path, this.settings(), style);
    this.cancelPending();
    HistoryManager.pushSnapshot(AppState.activeBoardId);
    return true;
  },

  finishPolygon() {
    if (AppState.activeTool === 'polygon') this.finishPending();
  },

  // --- Flood Fill Algorithm (Scanline BFS) ---
  executeFloodFill(startX, startY, hexFillColor) {
    const canvas = CanvasManager.mainCanvas;
    const ctx = CanvasManager.mainCtx;
    const w = canvas.width;
    const h = canvas.height;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const hasOtherLayers = CanvasManager.layers.some(layer => layer.visible && layer !== CanvasManager.activeLayer);
    const reference = hasOtherLayers
      ? CanvasManager.composite({ background: false }).getContext('2d').getImageData(0, 0, w, h).data
      : data;

    const fillRGB = this.hexToRGBA(hexFillColor);
    const startIndex = (startY * w + startX) * 4;

    const targetR = reference[startIndex];
    const targetG = reference[startIndex + 1];
    const targetB = reference[startIndex + 2];
    const targetA = reference[startIndex + 3];

    // Already filled
    if (
      Math.abs(targetR - fillRGB.r) < 5 &&
      Math.abs(targetG - fillRGB.g) < 5 &&
      Math.abs(targetB - fillRGB.b) < 5 &&
      Math.abs(targetA - fillRGB.a) < 5
    ) {
      return;
    }

    const tolerance = 28;
    const match = (idx) => {
      const dr = reference[idx] - targetR;
      const dg = reference[idx + 1] - targetG;
      const db = reference[idx + 2] - targetB;
      const da = reference[idx + 3] - targetA;
      return Math.sqrt(dr * dr + dg * dg + db * db + da * da) <= tolerance;
    };

    const pixelStack = [[startX, startY]];
    const seen = new Uint8Array(w * h);

    while (pixelStack.length > 0) {
      const [x, y] = pixelStack.pop();
      let curY = y;
      let curIdx = (curY * w + x) * 4;

      while (curY >= 0 && match(curIdx) && !seen[curY * w + x]) {
        curY--;
        curIdx -= w * 4;
      }
      curY++;
      curIdx += w * 4;

      let reachLeft = false;
      let reachRight = false;

      while (curY < h && match(curIdx) && !seen[curY * w + x]) {
        seen[curY * w + x] = 1;

        data[curIdx] = fillRGB.r;
        data[curIdx + 1] = fillRGB.g;
        data[curIdx + 2] = fillRGB.b;
        data[curIdx + 3] = fillRGB.a;

        if (x > 0) {
          const leftIdx = curIdx - 4;
          if (match(leftIdx) && !seen[curY * w + (x - 1)]) {
            if (!reachLeft) {
              pixelStack.push([x - 1, curY]);
              reachLeft = true;
            }
          } else {
            reachLeft = false;
          }
        }

        if (x < w - 1) {
          const rightIdx = curIdx + 4;
          if (match(rightIdx) && !seen[curY * w + (x + 1)]) {
            if (!reachRight) {
              pixelStack.push([x + 1, curY]);
              reachRight = true;
            }
          } else {
            reachRight = false;
          }
        }

        curY++;
        curIdx += w * 4;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    HistoryManager.pushSnapshot(AppState.activeBoardId);
    ToastManager.show('Flood fill complete', 'info', 1200);
  },

  // --- Eyedropper / Color Picker ---
  sampleColor(x, y, isSecondary = false) {
    const ctx = CanvasManager.composite({ background: true }).getContext('2d');
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    let hex = this.rgbaToHex(pixel[0], pixel[1], pixel[2]);

    if (pixel[3] === 0) {
      // Pixel is transparent, sample canvas background
      const board = BoardManager.getActiveBoard();
      hex = board ? board.background : '#ffffff';
      if (hex === 'transparent') hex = '#ffffff';
    }

    if (isSecondary) {
      UIManager.setSecondaryColor(hex);
      ToastManager.show(`Secondary color sampled: ${hex}`, 'info');
    } else {
      UIManager.setPrimaryColor(hex);
      ToastManager.show(`Primary color sampled: ${hex}`, 'info');
    }
  },

  hexToRGBA(hex) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255,
      a: Math.round(AppState.brushOpacity * 255)
    };
  },

  rgbaToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
};

// =============================================================================
// 9. TEXT MANAGER (Inline Text Placement & Typography)
// =============================================================================
const TableEditor = {
  layer: null,
  original: null,
  index: 0,

  init() {
    this.input = document.getElementById('tableCellEditor');
    this.input.addEventListener('input', () => this.update(this.input.value));
    this.input.addEventListener('blur', () => this.finish());
    this.input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        this.finish(event.key === 'Enter');
        CanvasManager.viewport.focus({ preventScroll: true });
      } else if (event.key === 'Tab') {
        const index = this.index + (event.shiftKey ? -1 : 1);
        if (index >= 0 && index < this.layer.table.cells.length) {
          event.preventDefault();
          this.open(this.layer, index);
        }
      }
    });
  },

  openAt({ x, y }) {
    const layer = CanvasManager.layers.findLast(({ visible, table }) =>
      visible && table && x >= table.x && x < table.x + table.width &&
      y >= table.y && y < table.y + table.height
    );
    if (!layer) return false;
    const table = layer.table;
    const { width, height } = tableCellLayout(table);
    const column = Math.floor((x - table.x) / width);
    const row = Math.floor((y - table.y) / height);
    this.open(layer, row * table.columns + column);
    return true;
  },

  open(layer, index) {
    if (this.layer === layer && this.index === index) {
      this.input.focus({ preventScroll: true });
      return;
    }
    this.finish();
    this.layer = layer;
    this.index = index;
    this.original = layer.table;
    const { x, y, columns, color, fontFamily, cells } = layer.table;
    const { width, height, padding, fontSize } = tableCellLayout(layer.table);
    const row = Math.floor(index / columns);
    const column = index % columns;
    const inset = Math.min(2, padding / 2);
    Object.assign(this.input.style, {
      left: `${x + column * width + inset}px`, top: `${y + row * height + inset}px`,
      width: `${width - 2 * inset}px`, height: `${height - 2 * inset}px`,
      padding: `0 ${padding - inset}px`, fontSize: `${fontSize}px`, fontFamily, color
    });
    this.input.setAttribute('aria-label', `Row ${row + 1}, column ${column + 1}`);
    this.input.value = cells[index];
    this.input.hidden = false;
    this.input.focus({ preventScroll: true });
  },

  update(value) {
    if (!this.layer || this.layer.table.cells[this.index] === value) return;
    const cells = this.layer.table.cells.slice();
    cells[this.index] = value;
    this.layer.table = { ...this.layer.table, cells };
    CanvasManager.drawTableLayer(this.layer);
    BoardManager.triggerAutosave();
  },

  finish(commit = true) {
    const layer = this.layer;
    if (!layer) return;
    const changed = layer.table.cells[this.index] !== this.original.cells[this.index];
    this.layer = null;
    this.input.hidden = true;
    if (changed && commit) {
      HistoryManager.pushSnapshot(CanvasManager.boardId, false);
    } else if (changed) {
      layer.table = this.original;
      CanvasManager.drawTableLayer(layer);
      if (CanvasManager.ready) BoardManager.triggerAutosave();
    }
  }
};

const TextManager = {
  container: null,
  activeNode: null,
  nodes: [],
  isDragging: false,
  dragOffset: { x: 0, y: 0 },

  init() {
    this.container = document.getElementById('floatingTextContainer');
    document.getElementById('textOpaque').addEventListener('change', () => this.updateActiveNodeStyle());

    // De-activate node on canvas click if active
    document.getElementById('canvasViewport').addEventListener('pointerdown', (e) => {
      if (e.target.closest('.floating-text-node')) return;
      if (AppState.activeTool !== 'text' && this.activeNode) {
         this.deactivateAll();
      }
    });

    document.addEventListener('pointermove', (e) => {
      if (this.isDragging && this.activeNode) {
        cancelAnimationFrame(this._raf);
        const node = this.activeNode;
        this._raf = requestAnimationFrame(() => {
          if (node !== this.activeNode || !node.isConnected) return;
          const coords = CanvasManager.getCanvasCoords(e);
          const newX = coords.x - this.dragOffset.x;
          const newY = coords.y - this.dragOffset.y;
          node.style.left = `${newX}px`;
          node.style.top = `${newY}px`;
          node.style.maxWidth = `calc(100% - ${newX}px)`;
          node.dataset.x = newX;
          node.dataset.y = newY;
          BoardManager.triggerAutosave();
        });
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (this.isDragging) {
        this.isDragging = false;
        // Text node state changes aren't tracked in canvas undo history
      }
    });
  },

  deactivateAll() {
    this.nodes.forEach(node => {
      node.classList.remove('active');
      node.querySelector('.text-content').blur();
    });
    this.activeNode = null;
  },

  openEditor(canvasX, canvasY, color = AppState.primaryColor) {
    this.deactivateAll();
    
    const node = document.createElement('div');
    node.className = 'floating-text-node active';
    node.style.position = 'absolute';
    node.style.left = `${canvasX}px`;
    node.style.top = `${canvasY}px`;
    node.style.maxWidth = `calc(100% - ${canvasX}px)`;
    node.dataset.x = canvasX;
    node.dataset.y = canvasY;
    
    const handle = document.createElement('div');
    handle.className = 'text-drag-handle';
    handle.title = 'Drag to move';
    
    handle.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.activeNode = node;
      const coords = CanvasManager.getCanvasCoords(e);
      this.dragOffset = {
        x: coords.x - parseFloat(node.dataset.x),
        y: coords.y - parseFloat(node.dataset.y)
      };
      e.stopPropagation();
    });
    
    const content = document.createElement('div');
    content.className = 'text-content';
    content.contentEditable = 'plaintext-only';
    content.setAttribute('role', 'textbox');
    content.setAttribute('aria-label', 'Canvas text');
    content.addEventListener('input', () => BoardManager.triggerAutosave());
    
    node.appendChild(handle);
    node.appendChild(content);
    
    this.container.appendChild(node);
    this.nodes.push(node);
    this.activeNode = node;
    
    this.updateActiveNodeStyle();
    content.style.color = color;
    
    setTimeout(() => {
      content.focus();
    }, 50);

    node.addEventListener('pointerdown', (e) => {
      if (e.target !== handle) {
        this.deactivateAll();
        node.classList.add('active');
        this.activeNode = node;
        
        // Sync the formatting ribbon state visually
        const opt = AppState.textOptions;
        document.getElementById('textFontFamily').value = content.style.fontFamily.replace(/"/g, '') || opt.fontFamily;
        document.getElementById('textFontSize').value = parseInt(content.style.fontSize) || opt.fontSize;
        
        const isBold = content.style.fontWeight === 'bold';
        const isItalic = content.style.fontStyle === 'italic';
        const isUnderline = content.style.textDecoration.includes('underline');
        const align = content.style.textAlign || 'left';
        
        AppState.textOptions.bold = isBold;
        AppState.textOptions.italic = isItalic;
        AppState.textOptions.underline = isUnderline;
        AppState.textOptions.align = align;
        
        document.getElementById('btnTextBold').classList.toggle('active', isBold);
        document.getElementById('btnTextItalic').classList.toggle('active', isItalic);
        document.getElementById('btnTextUnderline').classList.toggle('active', isUnderline);
        
        ['Left', 'Center', 'Right'].forEach(a => document.getElementById(`btnTextAlign${a}`).classList.remove('active'));
        document.getElementById(`btnTextAlign${align.charAt(0).toUpperCase() + align.slice(1)}`)?.classList.add('active');
      }
      e.stopPropagation();
    });
    
    content.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
         e.preventDefault();
         const key = e.key.toLowerCase();
         if (key === 'b') document.getElementById('btnTextBold').click();
         if (key === 'i') document.getElementById('btnTextItalic').click();
         if (key === 'u') document.getElementById('btnTextUnderline').click();
      }
    });

    content.addEventListener('blur', () => {
       if (!content.textContent.trim() && !this.isDragging) {
           node.remove();
           this.nodes = this.nodes.filter(n => n !== node);
       }
    });
  },

  updateActiveNodeStyle() {
    if (!this.activeNode) return;
    const content = this.activeNode.querySelector('.text-content');
    const opt = AppState.textOptions;
    content.style.fontFamily = opt.fontFamily;
    content.style.fontSize = `${opt.fontSize}px`;
    content.style.fontWeight = opt.bold ? 'bold' : 'normal';
    content.style.fontStyle = opt.italic ? 'italic' : 'normal';
    content.style.textDecoration = opt.underline ? 'underline' : 'none';
    content.style.textAlign = opt.align || 'left';
    content.style.backgroundColor = document.getElementById('textOpaque').checked ? AppState.secondaryColor : 'transparent';
    content.style.color = AppState.primaryColor;
    if (content.textContent.trim()) BoardManager.triggerAutosave();
  },

  updateColor() {
    if (!this.activeNode) return;
    const content = this.activeNode.querySelector('.text-content');
    content.style.color = AppState.primaryColor;
    if (content.textContent.trim()) BoardManager.triggerAutosave();
  },

  drawAllToCanvas(ctx) {
     this.nodes.forEach(node => {
        const content = node.querySelector('.text-content');
        if (!content.textContent.trim()) return;
        
        ctx.save();
        const x = parseFloat(node.dataset.x);
        const y = parseFloat(node.dataset.y);
        
        const style = window.getComputedStyle(content);
        if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
          ctx.fillStyle = style.backgroundColor;
          ctx.fillRect(x + content.offsetLeft, y + content.offsetTop, content.offsetWidth, content.offsetHeight);
        }
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.fillStyle = style.color;
        ctx.textAlign = style.textAlign.replace('start', 'left').replace('end', 'right');
        
        let alignX = x + parseFloat(style.paddingLeft || 0);
        if (ctx.textAlign === 'center') alignX = x + (node.offsetWidth / 2);
        if (ctx.textAlign === 'right') alignX = x + node.offsetWidth - parseFloat(style.paddingRight || 0);

        // Account for contentEditable padding
        const contentY = y + content.offsetTop + parseFloat(style.paddingTop || 0);
        
        const lines = content.innerText.split('\n');
        const lineHeight = parseFloat(style.fontSize) * 1.25;
        
        ctx.textBaseline = 'top';
        lines.forEach((line, i) => {
           const top = contentY + i * lineHeight;
           ctx.fillText(line, alignX, top);
           if (style.textDecorationLine.includes('underline')) {
             const width = ctx.measureText(line).width;
             const left = alignX - (ctx.textAlign === 'center' ? width / 2 : ctx.textAlign === 'right' ? width : 0);
             ctx.fillRect(left, top + parseFloat(style.fontSize), width, Math.max(1, parseFloat(style.fontSize) / 16));
           }
        });
        
        ctx.restore();
     });
  },
  
  commit() {
    if (!this.nodes.length) return;
    const hasText = this.nodes.some(node => node.querySelector('.text-content').textContent.trim());
    if (hasText) this.drawAllToCanvas(CanvasManager.mainCtx);
    this.clearAll();
    if (hasText) HistoryManager.pushSnapshot(AppState.activeBoardId);
  },

  clearAll() {
    this.nodes.forEach(n => n.remove());
    this.nodes = [];
    this.activeNode = null;
  }
};

// =============================================================================
// 10. SELECTION & CLIPBOARD MANAGER
// =============================================================================
const SelectionManager = {
  startPos: null,
  points: [],
  mode: 'rectangle',
  transparent: false,
  currentRect: null,
  mask: null,
  source: null,
  origin: null,
  floatingCanvas: null,
  lifted: false,

  init() {
    this.marqueeBox = document.getElementById('selectionMarqueeBox');
    this.outline = document.getElementById('selectionMaskOutline');
    this.toolbar = document.getElementById('selectionToolbar');
    document.getElementById('btnCopySel').onclick = () => this.copy();
    document.getElementById('btnCutSel').onclick = () => this.cut();
    document.getElementById('btnDelSel').onclick = () => this.deleteSelection();
    document.getElementById('btnDeselect').onclick = () => this.deselect();
    document.getElementById('selectionMode').onchange = event => {
      this.deselect();
      this.mode = event.target.value;
    };
    document.getElementById('transparentSelection').onchange = event => {
      this.transparent = event.target.checked;
      this.refreshPixels();
    };
    bindBitmapHandles(this.marqueeBox, {
      coords: event => CanvasManager.getCanvasCoords(event),
      bounds: () => this.getSelectionBounds(),
      hitTest: point => this.contains(point),
      update: rect => {
        this.liftSelection();
        this.currentRect = rect;
        this.updateMarqueeDOM();
      },
      finish: () => BoardManager.triggerAutosave()
    });
  },

  getSelectionBounds() {
    return this.source ? { ...this.currentRect } : null;
  },

  contains(point) {
    const { x, y, w, h } = this.currentRect;
    if (point.x < x || point.y < y || point.x >= x + w || point.y >= y + h) return false;
    if (!this.mask) return true;
    const mx = Math.floor((point.x - x) * this.mask.width / w);
    const my = Math.floor((point.y - y) * this.mask.height / h);
    return this.mask.getContext('2d').getImageData(mx, my, 1, 1).data[3] > 0;
  },

  onPointerDown(event, pos) {
    if (!CanvasManager.canEdit()) return;
    this.deselect();
    TextManager.commit();
    this.startPos = pos;
    this.points = [pos];
    this.currentRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
    this.updateMarqueeDOM();
  },

  onPointerMove(pos) {
    if (!this.startPos) return;
    if (this.mode === 'free-form') {
      const last = this.points[this.points.length - 1];
      if (pos.x === last.x && pos.y === last.y) return;
      this.points.push(pos);
      const r = this.currentRect;
      const left = Math.min(r.x, pos.x), top = Math.min(r.y, pos.y);
      this.currentRect = { x: left, y: top, w: Math.max(r.x + r.w, pos.x) - left, h: Math.max(r.y + r.h, pos.y) - top };
    } else {
      const { x, y } = this.startPos;
      this.currentRect = { x: Math.min(x, pos.x), y: Math.min(y, pos.y), w: Math.abs(pos.x - x), h: Math.abs(pos.y - y) };
    }
    this.updateMarqueeDOM();
  },

  tracePolygon(ctx) {
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
    ctx.closePath();
  },

  onPointerUp(pos) {
    if (!this.startPos) return;
    this.onPointerMove(pos);
    const { x, y, w, h } = this.currentRect;
    let area = validSize(w, h) ? { rect: this.currentRect, mask: null } : null;
    if (area && this.mode === 'free-form') {
      const mask = makeCanvas(w, h);
      const ctx = mask.getContext('2d');
      ctx.translate(-x, -y);
      this.tracePolygon(ctx);
      ctx.fill('evenodd');
      area = trimSelectionMask(mask, x, y);
    }
    this.reset();
    if (area) this.capture(area.rect, area.mask);
  },

  capture(rect, mask) {
    const { x, y, w, h } = rect;
    const tables = CanvasManager.layers.filter(layer => {
      if (!layer.visible) return false;
      if (layer.tableBitmap) return true;
      if (!layer.table) return false;
      const table = layer.table;
      const edge = (table.borderWidth ?? 2) / 2;
      return x < table.x + table.width + edge && x + w > table.x - edge &&
        y < table.y + table.height + edge && y + h > table.y - edge;
    });
    const raw = makeCanvas(w, h);
    const ctx = raw.getContext('2d');
    for (const layer of CanvasManager.layers) {
      if (layer === CanvasManager.activeLayer || tables.includes(layer)) ctx.drawImage(layer.canvas, -x, -y);
    }
    if (mask) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    this.currentRect = rect;
    this.mask = mask;
    this.origin = { rect: { ...rect }, mask, tables };
    this.source = raw;
    const paper = BoardManager.getActiveBoard().background;
    if (paper !== 'transparent' && CanvasManager.layers
      .slice(0, CanvasManager.layers.indexOf(CanvasManager.activeLayer))
      .every(layer => !layer.visible || layer.table || layer.tableBitmap)) {
      // Color the paper in an opaque base-layer selection while retaining the
      // original alpha for cancellation and for the other layers.
      this.source = scaleBitmap(raw, w, h);
      const paperCtx = this.source.getContext('2d');
      paperCtx.globalCompositeOperation = 'destination-over';
      paperCtx.fillStyle = paper;
      paperCtx.fillRect(0, 0, w, h);
      if (mask) {
        paperCtx.globalCompositeOperation = 'destination-in';
        paperCtx.drawImage(mask, 0, 0);
      }
    }
    AppState.selection.active = true;
    drawMaskOutline(this.outline, mask);
    this.refreshPixels();
  },

  refreshPixels() {
    if (!this.source) return;
    this.floatingCanvas = this.source;
    if (this.transparent) {
      const { width, height } = this.source;
      const bitmap = scaleBitmap(this.source, width, height);
      const ctx = bitmap.getContext('2d');
      const pixels = ctx.getImageData(0, 0, width, height);
      const key = parseInt(AppState.secondaryColor.slice(1), 16);
      const r = key >> 16, g = (key >> 8) & 255, b = key & 255;
      for (let i = 0; i < pixels.data.length; i += 4) {
        if (pixels.data[i] === r && pixels.data[i + 1] === g && pixels.data[i + 2] === b) pixels.data[i + 3] = 0;
      }
      ctx.putImageData(pixels, 0, 0);
      this.floatingCanvas = bitmap;
    }
    this.updateMarqueeDOM();
    if (this.lifted) BoardManager.triggerAutosave();
  },

  // Untouched selections stay in the layer. Lift pixels only on the first edit.
  liftSelection() {
    if (this.lifted || !this.origin) return;
    const { rect: { x, y, w, h }, mask, tables } = this.origin;
    const layers = CanvasManager.layers;
    const active = CanvasManager.activeLayer;
    const raw = makeCanvas(w, h);
    const rawCtx = raw.getContext('2d');
    rawCtx.drawImage(active.canvas, -x, -y);
    if (mask) {
      rawCtx.globalCompositeOperation = 'destination-in';
      rawCtx.drawImage(mask, 0, 0);
    }
    const clearRegion = ctx => {
      if (!mask) {
        ctx.clearRect(x, y, w, h);
        return;
      }
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(mask, x, y);
      ctx.restore();
    };
    clearRegion(CanvasManager.mainCtx);
    this.origin.raw = raw;
    this.origin.layers = layers;
    active.png = undefined;
    if (tables.length) CanvasManager.layers = layers.flatMap(layer => {
      if (!tables.includes(layer)) return [layer];
      if (!mask && layer.table) {
        const table = layer.table;
        const edge = (table.borderWidth ?? 2) / 2;
        if (x <= Math.max(0, table.x - edge) && y <= Math.max(0, table.y - edge) &&
            x + w >= Math.min(layer.canvas.width, table.x + table.width + edge) &&
            y + h >= Math.min(layer.canvas.height, table.y + table.height + edge)) return [];
      }
      // ponytail: partial pixel edits bake the intersecting table. Undo restores its editable version.
      const { table: _, ...rest } = layer;
      const canvas = scaleBitmap(layer.canvas, layer.canvas.width, layer.canvas.height);
      clearRegion(canvas.getContext('2d'));
      return [{ ...rest, canvas, png: undefined, tableBitmap: true }];
    });
    if (tables.length) CanvasManager.mountLayers();
    this.lifted = true;
  },

  drawFloatingTo(ctx) {
    if (!this.lifted || !this.floatingCanvas) return;
    const { x, y, w, h } = this.currentRect;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.floatingCanvas, x, y, w, h);
    ctx.restore();
  },

  commitFloatingSelection() {
    const changed = this.lifted;
    if (changed) this.drawFloatingTo(CanvasManager.mainCtx);
    this.reset();
    if (changed) HistoryManager.pushSnapshot(AppState.activeBoardId);
  },

  deselect() {
    if (this.source || this.startPos) this.commitFloatingSelection();
  },

  reset() {
    this.startPos = this.currentRect = this.mask = this.source = this.origin = this.floatingCanvas = null;
    this.points = [];
    this.lifted = false;
    AppState.selection.active = false;
    this.marqueeBox.style.display = 'none';
    this.toolbar.hidden = true;
    this.marqueeBox.classList.remove('free-preview', 'drawing-marquee');
    drawMaskOutline(this.outline, null);
    document.getElementById('statusSelectionWrap').style.display = 'none';
    CanvasManager.clearOverlay();
  },

  cancelGesture() {
    if (this.startPos) this.reset();
  },

  cancel() {
    if (!this.source && !this.startPos) return false;
    if (this.lifted && this.origin) {
      const { raw, rect, layers, tables } = this.origin;
      CanvasManager.mainCtx.drawImage(raw, rect.x, rect.y);
      CanvasManager.activeLayer.png = undefined;
      if (tables.length) {
        CanvasManager.layers = layers;
        CanvasManager.mountLayers();
      }
    }
    const changed = this.lifted;
    this.reset();
    if (changed) BoardManager.triggerAutosave();
    return true;
  },

  selectAll() {
    if (!CanvasManager.canEdit()) return;
    ToolManager.setTool('select');
    TextManager.commit();
    this.deselect();
    this.capture({ x: 0, y: 0, w: CanvasManager.mainCanvas.width, h: CanvasManager.mainCanvas.height }, null);
  },

  invertSelection() {
    if (!this.source) { this.selectAll(); return; }
    const { x, y, w, h } = this.currentRect;
    const mask = makeCanvas(CanvasManager.mainCanvas.width, CanvasManager.mainCanvas.height);
    const ctx = mask.getContext('2d');
    ctx.fillRect(0, 0, mask.width, mask.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = false;
    if (this.mask) ctx.drawImage(this.mask, x, y, w, h);
    else ctx.fillRect(x, y, w, h);
    const area = trimSelectionMask(mask, 0, 0);
    this.deselect();
    if (area) this.capture(area.rect, area.mask);
  },

  transformFloating(operation) {
    if (!this.source) return false;
    const { w, h } = this.currentRect;
    const invert = operation === 'invert';
    // Invert visible pixels; hidden Color 2 must stay transparent.
    const bitmap = transformBitmap(invert ? this.floatingCanvas : this.source, w, h, operation);
    const mask = this.mask && transformBitmap(this.mask, w, h, invert ? '' : operation);
    this.replaceBitmap(bitmap, mask, invert);
    return true;
  },

  resizeFloating(width, height, skewX = 0, skewY = 0) {
    if (!this.source) return false;
    const bitmap = resizeBitmap(this.source, width, height, true, skewX, skewY);
    let mask = this.mask;
    if (!mask && (skewX || skewY)) {
      mask = makeCanvas(1, 1);
      mask.getContext('2d').fillRect(0, 0, 1, 1);
    }
    if (mask) mask = resizeBitmap(mask, width, height, true, skewX, skewY);
    this.replaceBitmap(bitmap, mask);
    return true;
  },

  replaceBitmap(bitmap, mask, useAsRendered = false) {
    this.liftSelection();
    this.source = bitmap;
    this.mask = mask;
    this.currentRect = { ...this.currentRect, w: bitmap.width, h: bitmap.height };
    drawMaskOutline(this.outline, mask);
    if (useAsRendered) {
      this.floatingCanvas = bitmap;
      this.updateMarqueeDOM();
      BoardManager.triggerAutosave();
    } else this.refreshPixels();
  },

  copy() {
    if (!this.floatingCanvas) return;
    const { w, h } = this.currentRect;
    const bitmap = scaleBitmap(this.floatingCanvas, w, h);
    AppState.clipboardImageData = bitmap;
    this.clipboardMask = this.mask && scaleBitmap(this.mask, w, h);
    this.localClipboard = true;
    if (navigator.clipboard?.write && window.ClipboardItem) {
      try {
        // Pass the promise while the click or key event still has user activation.
        const item = new ClipboardItem({ 'image/png': bitmapBlob(bitmap, 'image/png') });
        navigator.clipboard.write([item]).then(() => {
          if (bitmap === AppState.clipboardImageData) this.localClipboard = false;
        }).catch(() => {});
      } catch { /* The in-app clipboard remains available. */ }
    }
    ToastManager.show('Selection copied', 'info', 1500);
  },

  cut() {
    if (!this.source) return;
    this.copy();
    this.deleteSelection();
  },

  deleteSelection() {
    if (!this.source) return;
    this.liftSelection();
    const removedOriginal = Boolean(this.origin);
    this.reset();
    if (removedOriginal) HistoryManager.pushSnapshot(AppState.activeBoardId);
    else BoardManager.triggerAutosave();
  },

  pasteCustom(image, x, y, mask = null) {
    if (!CanvasManager.canEdit()) return;
    const w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
    if (!validSize(w, h)) return;
    ToolManager.setTool('select');
    TextManager.commit();
    this.deselect();
    if (x == null || y == null) {
      const viewport = CanvasManager.viewport.getBoundingClientRect();
      const art = CanvasManager.artboard.getBoundingClientRect();
      const cx = (Math.max(art.left, viewport.left) + Math.min(art.right, viewport.right)) / 2;
      const cy = (Math.max(art.top, viewport.top) + Math.min(art.bottom, viewport.bottom)) / 2;
      const center = CanvasManager.getCanvasCoords({ clientX: cx, clientY: cy });
      x = Math.max(0, Math.min(CanvasManager.mainCanvas.width - w, Math.round(center.x - w / 2)));
      y = Math.max(0, Math.min(CanvasManager.mainCanvas.height - h, Math.round(center.y - h / 2)));
    }
    this.currentRect = { x, y, w, h };
    this.source = scaleBitmap(image, w, h);
    this.mask = mask;
    this.lifted = true;
    AppState.selection.active = true;
    drawMaskOutline(this.outline, mask);
    this.refreshPixels();
  },

  async paste() {
    if (!CanvasManager.canEdit()) return;
    const layer = CanvasManager.activeLayer;
    try {
      const items = await navigator.clipboard.read();
      if (CanvasManager.activeLayer !== layer) return;
      for (const item of items) {
        const type = item.types.find(type => type.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        if (CanvasManager.activeLayer === layer) await ImageManager.handleImageFile(blob, 'paste');
        return;
      }
    } catch { /* Fall back to the previous in-app copy when access is unavailable. */ }
    if (CanvasManager.activeLayer !== layer) return;
    if (AppState.clipboardImageData) this.pasteCustom(AppState.clipboardImageData, null, null, this.clipboardMask);
    else ToastManager.show('Use the paste shortcut to paste a clipboard image.', 'info');
  },

  updateMarqueeDOM() {
    if (!this.currentRect) return;
    const { x, y, w, h } = this.currentRect;
    Object.assign(this.marqueeBox.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    const tracing = Boolean(this.startPos && this.mode === 'free-form');
    this.marqueeBox.classList.toggle('drawing-marquee', Boolean(this.startPos));
    this.toolbar.hidden = Boolean(this.startPos);
    this.marqueeBox.classList.toggle('free-preview', tracing);
    document.getElementById('statusSelectionWrap').style.display = 'flex';
    document.getElementById('statusSelectionDimensions').textContent = w + ' × ' + h + ' px';
    CanvasManager.clearOverlay();
    const ctx = CanvasManager.overlayCtx;
    this.drawFloatingTo(ctx);
    if (tracing) {
      ctx.save();
      this.tracePolygon(ctx);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'white';
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'black';
      ctx.stroke();
      ctx.restore();
    }
  }
};

// =============================================================================
// 11. IMAGE IMPORT & EXPORT MANAGER
// =============================================================================
const ImageManager = {
  imgRect: null,
  fileRequest: 0,

  init() {
    this.floatingLayer = document.getElementById('floatingImageLayer');
    this.floatingImg = document.getElementById('floatingImagePreview');
    this.actionBar = document.getElementById('imageActions');
    document.getElementById('btnApplyImage').onclick = () => this.placeImage();
    document.getElementById('btnCancelImage').onclick = () => this.cancelImage();

    for (const [id, mode] of [['fileInputImage', 'open'], ['fileInputInsertImage', 'insert']]) {
      document.getElementById(id).onchange = event => {
        const file = event.target.files[0];
        event.target.value = '';
        if (file) this.handleImageFile(file, mode);
      };
    }
    bindBitmapHandles(this.floatingLayer, {
      coords: event => CanvasManager.getCanvasCoords(event),
      bounds: () => this.imgRect,
      update: rect => { this.imgRect = rect; this.updateDOM(); }
    });

    const modal = document.getElementById('saveAsModal');
    const close = () => modal.close();
    document.getElementById('btnSaveAsClose').onclick = close;
    document.getElementById('btnSaveAsCancel').onclick = close;
    const format = document.getElementById('saveImageFormat');
    const webp = format.querySelector('[value="webp"]');
    if (!makeCanvas(1, 1).toDataURL('image/webp').startsWith('data:image/webp')) webp.remove();
    document.getElementById('saveAsForm').onsubmit = async event => {
      event.preventDefault();
      const save = document.getElementById('btnSaveImage');
      if (save.disabled) return;
      save.disabled = true;
      const success = await this.saveImage(format.value, document.getElementById('saveImageName').value);
      save.disabled = false;
      if (success) close();
    };
    window.addEventListener('beforeprint', () => this.preparePrint());
    window.addEventListener('afterprint', () => document.getElementById('printArtwork').replaceChildren());
  },

  async handleImageFile(file, mode = 'insert') {
    const ticket = ++this.fileRequest;
    const layer = CanvasManager.activeLayer;
    const url = URL.createObjectURL(file);
    try {
      let image = new Image();
      image.src = url;
      try { await image.decode(); }
      catch (error) {
        if (!/tiff/i.test(file.type) && !/\.tiff?$/i.test(file.name || '')) throw error;
        image = await decodeTiff(file);
      }
      if (ticket !== this.fileRequest) return;
      if (mode === 'open') {
        BoardManager.openImage(file.name || 'Image', image);
        return;
      }
      if (layer !== CanvasManager.activeLayer || !CanvasManager.canEdit()) return;
      if (mode === 'paste') {
        if (!validSize(image.naturalWidth, image.naturalHeight)) throw new Error('Image dimensions exceed the board limit');
        SelectionManager.pasteCustom(image);
        return;
      }

      TextManager.commit();
      SelectionManager.deselect();
      const width = CanvasManager.mainCanvas.width, height = CanvasManager.mainCanvas.height;
      const scale = Math.min(1, width * 0.8 / image.naturalWidth, height * 0.8 / image.naturalHeight);
      const w = Math.max(1, Math.round(image.naturalWidth * scale)), h = Math.max(1, Math.round(image.naturalHeight * scale));
      this.imgRect = { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
      image.id = this.floatingImg.id;
      image.alt = this.floatingImg.alt;
      image.draggable = false;
      this.floatingImg.replaceWith(image);
      this.floatingImg = image;
      this.floatingLayer.style.display = 'block';
      this.actionBar.hidden = false;
      this.updateDOM();
    } catch {
      if (ticket === this.fileRequest) ToastManager.show('Could not open this image. Check its format and dimensions.', 'warn');
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  placeImage() {
    if (!this.imgRect || !CanvasManager.canEdit()) return;
    const { x, y, w, h } = this.imgRect;
    const ctx = CanvasManager.mainCtx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.floatingImg, x, y, w, h);
    ctx.restore();
    this.cancelImage();
    HistoryManager.pushSnapshot(AppState.activeBoardId);
    ToastManager.show('Image placed', 'success');
  },

  cancelImage() {
    this.fileRequest++;
    this.imgRect = null;
    this.floatingLayer.style.display = 'none';
    this.actionBar.hidden = true;
    this.floatingImg.removeAttribute('src');
  },

  updateDOM() {
    const { x, y, w, h } = this.imgRect;
    Object.assign(this.floatingLayer.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  },

  showSaveAs() {
    if (!CanvasManager.ready) return;
    const input = document.getElementById('saveImageName');
    input.value = BoardManager.getActiveBoard().name.replace(/\.(png|jpe?g|bmp|webp|gif|tiff?)$/i, '');
    document.getElementById('saveAsModal').showModal();
    input.select();
  },

  async saveImage(format, filename) {
    if (!CanvasManager.ready) return false;
    try {
      const canvas = CanvasManager.composite({ background: true, opaque: format === 'jpg' || format === 'bmp' });
      const blob = ['gif', 'tiff'].includes(format) ? await exportPaintFile(canvas, format)
        : await bitmapBlob(canvas, format === 'jpg' ? 'image/jpeg' : 'image/' + format);
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      const stem = filename.trim().replace(/\.(png|jpe?g|bmp|webp|gif|tiff?)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'PaintBoard';
      link.download = stem + '.' + format;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      ToastManager.show('Saved ' + link.download, 'success');
      return true;
    } catch {
      ToastManager.show('Could not save the image in this format.', 'warn');
      return false;
    }
  },

  exportPNG() { return this.saveImage('png', 'PaintBoard_' + BoardManager.getActiveBoard().name); },
  exportJPG() { return this.saveImage('jpg', 'PaintBoard_' + BoardManager.getActiveBoard().name); },

  preparePrint() {
    if (!CanvasManager.ready) return false;
    const artwork = document.getElementById('printArtwork');
    if (!artwork.firstChild) artwork.appendChild(CanvasManager.composite({ background: true, opaque: true }));
    return true;
  },

  print() {
    if (this.preparePrint()) window.print();
  }
};

// =============================================================================
// 12. UI & CONTROLS MANAGER
// =============================================================================
const UIManager = {
  init() {
    this.buildColorPalette();
    this.bindToolClickEvents();
    this.bindPropertyBarEvents();
    this.bindMenuBarEvents();
    this.bindModalEvents();
    this.bindSidebar();
    this.bindKeyboardShortcuts();
    this.bindQuickActions();
  },

  buildColorPalette() {
    const container = document.getElementById('paletteSwatches');
    if (!container) return;
    container.innerHTML = '';

    PALETTE_COLORS.forEach(color => {
      const swatch = document.createElement('button');
      swatch.className = 'swatch-btn';
      swatch.style.backgroundColor = color;
      swatch.title = color;
      swatch.setAttribute('aria-label', `Color ${color}`);

      // Left click = Primary Color, Right click = Secondary Color
      swatch.addEventListener('click', () => {
        this.setPrimaryColor(color);
      });
      swatch.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.setSecondaryColor(color);
      });

      container.appendChild(swatch);
    });
  },

  setPrimaryColor(hex) {
    AppState.primaryColor = hex;
    document.getElementById('primaryColorPicker').value = hex;
    document.getElementById('primaryHex').value = hex;
    if (typeof TextManager !== 'undefined') TextManager.updateColor();
  },

  setSecondaryColor(hex) {
    AppState.secondaryColor = hex;
    document.getElementById('secondaryColorPicker').value = hex;
    document.getElementById('secondaryHex').value = hex;
    if (SelectionManager.transparent) SelectionManager.refreshPixels();
  },

  swapColors() {
    const temp = AppState.primaryColor;
    this.setPrimaryColor(AppState.secondaryColor);
    this.setSecondaryColor(temp);
  },

  bindToolClickEvents() {
    const gallery = document.getElementById('shapeGallery');
    for (const [id, [name]] of Object.entries(SHAPES)) gallery.add(new Option(name, id));
    gallery.addEventListener('change', () => ToolManager.setTool(gallery.value));
    ToolManager.setTool(AppState.activeTool);
    document.querySelectorAll('.tool-card').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tool === 'table') ModalManager.showInsertTable(btn);
        else ToolManager.setTool(btn.dataset.tool);
      });
    });

    document.querySelectorAll('.tool-select').forEach(btn => {
      btn.addEventListener('click', () => {
        ToolManager.setTool(btn.dataset.tool);
        this.closeAllMenus();
      });
    });
  },

  bindPropertyBarEvents() {
    // Size presets
    document.querySelectorAll('.size-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = parseInt(btn.dataset.size, 10);
        AppState.brushSize = size;
        document.getElementById('brushSizeSlider').value = size;
        document.getElementById('brushSizeVal').textContent = `${size}px`;
        document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    // Size Slider
    const sizeSlider = document.getElementById('brushSizeSlider');
    sizeSlider.addEventListener('input', (e) => {
      const size = parseInt(e.target.value, 10);
      AppState.brushSize = size;
      document.getElementById('brushSizeVal').textContent = `${size}px`;
      document.querySelectorAll('.size-preset-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.size, 10) === size);
      });
    });

    // Opacity Slider
    const opSlider = document.getElementById('brushOpacitySlider');
    opSlider.addEventListener('input', (e) => {
      const op = parseInt(e.target.value, 10);
      AppState.brushOpacity = op / 100;
      document.getElementById('brushOpacityVal').textContent = `${op}%`;
    });

    // Shape Fill Mode
    const shapeMode = document.getElementById('shapeFillModeSelect');
    shapeMode.addEventListener('change', (e) => {
      AppState.shapeFillMode = e.target.value;
    });

    const materials = { solid: 'Solid color', crayon: 'Crayon', marker: 'Marker', oil: 'Oil brush', naturalPencil: 'Natural pencil', watercolor: 'Watercolor' };
    for (const [id, property] of [['shapeOutlineStyle', 'outlineStyle'], ['shapeFillStyle', 'fillStyle']]) {
      const select = document.getElementById(id);
      for (const [value, label] of Object.entries(materials)) select.add(new Option(label, value));
      if (property === 'fillStyle') select.add(new Option('Gradient', 'gradient'));
      select.addEventListener('change', () => { AppState[property] = select.value; });
    }

    // Brush Tip
    const brushTip = document.getElementById('brushTipSelect');
    for (const [value, label] of Object.entries(BRUSHES)) brushTip.add(new Option(label, value));
    brushTip.addEventListener('change', (e) => {
      AppState.brushTip = e.target.value;
    });

    // Native color pickers and hex fields
    for (const which of ['primary', 'secondary']) {
      const field = document.getElementById(which + 'Hex');
      field.addEventListener('change', () => {
        const match = /^#?([0-9a-f]{6})$/i.exec(field.value.trim());
        if (match) {
          if (which === 'primary') this.setPrimaryColor('#' + match[1]);
          else this.setSecondaryColor('#' + match[1]);
        } else {
          field.value = AppState[which + 'Color'];
          ToastManager.show('Enter a six-digit hex color, such as #0078d4.', 'info');
        }
      });
      field.addEventListener('keydown', e => { if (e.key === 'Enter') field.blur(); });
    }
    const primaryPicker = document.getElementById('primaryColorPicker');
    primaryPicker.addEventListener('input', (e) => this.setPrimaryColor(e.target.value));

    const secondaryPicker = document.getElementById('secondaryColorPicker');
    secondaryPicker.addEventListener('input', (e) => this.setSecondaryColor(e.target.value));

    // Swap Colors Button
    document.getElementById('btnSwapColors').addEventListener('click', () => this.swapColors());

    // Background Presets & Custom Picker
    document.querySelectorAll('.bg-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        CanvasManager.setBackground(btn.dataset.bg);
      });
    });

    const customBg = document.getElementById('customBgColorPicker');
    customBg.addEventListener('input', (e) => {
      CanvasManager.setBackground(e.target.value);
    });

    // Text formatting
    document.getElementById('textFontFamily').addEventListener('change', (e) => {
      AppState.textOptions.fontFamily = e.target.value;
      if (TextManager.activeNode) TextManager.updateActiveNodeStyle();
    });
    document.getElementById('textFontSize').addEventListener('change', (e) => {
      AppState.textOptions.fontSize = parseInt(e.target.value, 10);
      if (TextManager.activeNode) TextManager.updateActiveNodeStyle();
    });

    document.getElementById('btnTextBold').addEventListener('click', function () {
      AppState.textOptions.bold = !AppState.textOptions.bold;
      this.classList.toggle('active', AppState.textOptions.bold);
      if (TextManager.activeNode) TextManager.updateActiveNodeStyle();
    });
    document.getElementById('btnTextItalic').addEventListener('click', function () {
      AppState.textOptions.italic = !AppState.textOptions.italic;
      this.classList.toggle('active', AppState.textOptions.italic);
      if (TextManager.activeNode) TextManager.updateActiveNodeStyle();
    });
    document.getElementById('btnTextUnderline').addEventListener('click', function () {
      AppState.textOptions.underline = !AppState.textOptions.underline;
      this.classList.toggle('active', AppState.textOptions.underline);
      if (TextManager.activeNode) TextManager.updateActiveNodeStyle();
    });

    const alignBtns = ['Left', 'Center', 'Right'];
    alignBtns.forEach(align => {
      document.getElementById(`btnTextAlign${align}`).addEventListener('click', function() {
        AppState.textOptions.align = align.toLowerCase();
        alignBtns.forEach(a => document.getElementById(`btnTextAlign${a}`).classList.remove('active'));
        this.classList.add('active');
        if (TextManager.activeNode) TextManager.updateActiveNodeStyle();
      });
    });
  },

  bindMenuBarEvents() {
    const menuItems = document.querySelectorAll('.menu-item');

    menuItems.forEach(item => {
      const btn = item.querySelector('.menu-btn');
      btn.setAttribute('aria-controls', item.querySelector('.dropdown-panel').id);
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = item.classList.contains('active');
        this.closeAllMenus();
        if (!isOpen) {
          item.classList.add('active');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });

    window.addEventListener('click', () => this.closeAllMenus());

    // File Menu Actions
    document.getElementById('menuItemNewBoard').addEventListener('click', () => {
      BoardManager.createNewBoard();
      this.closeAllMenus();
    });
    document.getElementById('menuItemOpenImage').addEventListener('click', () => {
      document.getElementById('fileInputImage').click();
      this.closeAllMenus();
    });
    document.getElementById('menuItemInsertImage').addEventListener('click', () => document.getElementById('fileInputInsertImage').click());
    document.getElementById('menuItemInsertTable').addEventListener('click', () => {
      this.closeAllMenus();
      ModalManager.showInsertTable(document.getElementById('menuBtnFile'));
    });
    document.getElementById('menuItemSaveAs').addEventListener('click', () => ImageManager.showSaveAs());
    document.getElementById('menuItemPrint').addEventListener('click', () => ImageManager.print());
    document.getElementById('menuItemSaveProject').addEventListener('click', () => {
      StorageManager.exportProjectJSON();
      this.closeAllMenus();
    });
    document.getElementById('menuItemImportProject').addEventListener('click', () => {
      document.getElementById('fileInputProject').click();
      this.closeAllMenus();
    });
    document.getElementById('menuItemExportPNG').addEventListener('click', () => {
      ImageManager.exportPNG();
      this.closeAllMenus();
    });
    document.getElementById('menuItemExportJPG').addEventListener('click', () => {
      ImageManager.exportJPG();
      this.closeAllMenus();
    });
    document.getElementById('menuItemResetAll').addEventListener('click', () => {
      this.closeAllMenus();
      ModalManager.showConfirm(
        'Reset Workspace',
        'Are you sure you want to reset all whiteboards to default?',
        'All boards in this browser session will be replaced with a fresh blank whiteboard.',
        'Reset All',
        () => {
          AppState.isSaving = false;
          clearTimeout(AppState.saveTimeout);
          localStorage.removeItem(STORAGE_KEY_BOARDS);
          localStorage.removeItem(STORAGE_KEY_ACTIVE);
          location.reload();
        },
        true
      );
    });

    // Edit Menu Actions
    document.getElementById('menuItemUndo').addEventListener('click', () => {
      HistoryManager.undo();
      this.closeAllMenus();
    });
    document.getElementById('menuItemRedo').addEventListener('click', () => {
      HistoryManager.redo();
      this.closeAllMenus();
    });
    document.getElementById('menuItemCut').addEventListener('click', () => {
      SelectionManager.cut();
      this.closeAllMenus();
    });
    document.getElementById('menuItemCopy').addEventListener('click', () => {
      SelectionManager.copy();
      this.closeAllMenus();
    });
    document.getElementById('menuItemPaste').addEventListener('click', () => {
      SelectionManager.paste();
      this.closeAllMenus();
    });
    document.getElementById('menuItemSelectAll').addEventListener('click', () => {
      SelectionManager.selectAll();
      this.closeAllMenus();
    });
    document.getElementById('menuItemInvertSelection').addEventListener('click', () => SelectionManager.invertSelection());
    document.getElementById('menuItemDeleteSelection').addEventListener('click', () => {
      SelectionManager.deleteSelection();
      this.closeAllMenus();
    });
    document.getElementById('menuItemClearBoard').addEventListener('click', () => {
      this.closeAllMenus();
      ModalManager.showClearCanvas(BoardManager.getActiveBoard(), document.getElementById('menuBtnEdit'));
    });

    // View Menu Actions
    document.getElementById('menuItemZoomIn').addEventListener('click', () => {
      CanvasManager.zoomIn();
      this.closeAllMenus();
    });
    document.getElementById('menuItemZoomOut').addEventListener('click', () => {
      CanvasManager.zoomOut();
      this.closeAllMenus();
    });
    document.getElementById('menuItemResetZoom').addEventListener('click', () => {
      CanvasManager.resetZoom();
      this.closeAllMenus();
    });
    document.getElementById('menuItemFitCanvas').addEventListener('click', () => {
      CanvasManager.fitToWindow();
      this.closeAllMenus();
    });
    document.querySelectorAll('button[data-guide]').forEach(button => {
      button.addEventListener('click', () => {
        CanvasManager.toggleGuide(button);
        this.closeAllMenus();
      });
    });

    // Grid Spacing Submenu
    document.querySelectorAll('.spacing-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.spacing-btn').forEach(b => b.classList.toggle('active', b === btn));
        CanvasManager.setGridSpacing(btn.dataset.spacing);
      });
    });

    // Image Menu Actions
    document.getElementById('menuItemCrop').addEventListener('click', () => CanvasManager.crop());
    document.getElementById('menuItemInvert').addEventListener('click', () => CanvasManager.applyTransform('invert'));
    document.getElementById('menuItemResizeCanvas').addEventListener('click', () => {
      ModalManager.showResize();
      this.closeAllMenus();
    });
    document.getElementById('menuItemRotateCW').addEventListener('click', () => {
      CanvasManager.rotateCanvas(90);
      this.closeAllMenus();
    });
    document.getElementById('menuItemRotateCCW').addEventListener('click', () => {
      CanvasManager.rotateCanvas(-90);
      this.closeAllMenus();
    });
    document.getElementById('menuItemRotate180').addEventListener('click', () => {
      CanvasManager.rotateCanvas(180);
      this.closeAllMenus();
    });
    document.getElementById('menuItemFlipH').addEventListener('click', () => {
      CanvasManager.flipCanvas(true);
      this.closeAllMenus();
    });
    document.getElementById('menuItemFlipV').addEventListener('click', () => {
      CanvasManager.flipCanvas(false);
      this.closeAllMenus();
    });
    document.getElementById('menuItemChangeBackground').addEventListener('click', () => {
      document.getElementById('customBgColorPicker').click();
      this.closeAllMenus();
    });

    // Help Menu Actions
    document.getElementById('menuItemShortcuts').addEventListener('click', () => {
      ModalManager.showShortcuts();
      this.closeAllMenus();
    });
    document.getElementById('menuItemAbout').addEventListener('click', () => {
      ModalManager.showAbout();
      this.closeAllMenus();
    });

    // Project file input handler
    document.getElementById('fileInputProject').addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        StorageManager.importProjectJSON(e.target.files[0]);
        e.target.value = '';
      }
    });
  },

  closeAllMenus() {
    document.querySelectorAll('.menu-item.active').forEach(item => {
      item.classList.remove('active');
      item.querySelector('.menu-btn').setAttribute('aria-expanded', 'false');
    });
    document.querySelectorAll('.board-context-menu.show').forEach(m => m.classList.remove('show'));
  },

  bindTableModalEvents() {
    const tableModal = document.getElementById('insertTableModal');
    const rowInput = document.getElementById('tableRows');
    const columnInput = document.getElementById('tableColumns');
    document.getElementById('btnInsertTableCancel').addEventListener('click', () => tableModal.close());
    tableModal.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      ToolManager.table = {
        rows: rowInput.valueAsNumber,
        columns: columnInput.valueAsNumber
      };
      tableModal.close();
      ToolManager.setTool('table');
      CanvasManager.viewport.focus({ preventScroll: true });
      ToastManager.show('Drag to place the table, then type in a cell.', 'info');
    });
  },

  bindModalEvents() {
    this.bindTableModalEvents();
    // Confirm Modal
    document.getElementById('confirmModal').addEventListener('cancel', () => { ModalManager.confirmCallback = null; });
    document.getElementById('btnConfirmClose').addEventListener('click', () => ModalManager.closeConfirm());
    document.getElementById('btnConfirmCancel').addEventListener('click', () => ModalManager.closeConfirm());
    document.getElementById('btnConfirmAction').addEventListener('click', () => {
      const confirm = ModalManager.confirmCallback;
      ModalManager.closeConfirm();
      confirm?.();
    });

    // Rename Modal
    document.getElementById('btnRenameClose').addEventListener('click', () => ModalManager.closeRename());
    document.getElementById('btnRenameCancel').addEventListener('click', () => ModalManager.closeRename());
    document.getElementById('btnRenameSave').addEventListener('click', () => {
      const input = document.getElementById('renameBoardInput');
      BoardManager.renameBoard(AppState.activeBoardId, input.value);
      ModalManager.closeRename();
    });
    document.getElementById('renameBoardInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        BoardManager.renameBoard(AppState.activeBoardId, e.target.value);
        ModalManager.closeRename();
      }
    });

    // Resize Modal
    const resizeModal = document.getElementById('resizeCanvasModal');
    const resizeW = document.getElementById('resizeWidthInput');
    const resizeH = document.getElementById('resizeHeightInput');
    const units = document.getElementById('resizeUnits');
    const scale = document.getElementById('resizeScaleContent');
    units.addEventListener('change', () => {
      const percent = units.value === 'percent';
      resizeW.value = percent ? 100 : resizeModal.dataset.width;
      resizeH.value = percent ? 100 : resizeModal.dataset.height;
      scale.checked = percent || Boolean(SelectionManager.getSelectionBounds?.());
      scale.disabled = scale.checked;
    });
    for (const [input, other, size, otherSize] of [
      [resizeW, resizeH, 'width', 'height'], [resizeH, resizeW, 'height', 'width']
    ]) {
      input.addEventListener('input', () => {
        if (!document.getElementById('resizeMaintainAspect').checked || !(input.valueAsNumber > 0)) return;
        const ratio = units.value === 'percent' ? 1 : resizeModal.dataset[otherSize] / resizeModal.dataset[size];
        other.value = Math.max(1, Math.round(input.valueAsNumber * ratio));
      });
    }
    document.getElementById('btnResizeClose').addEventListener('click', () => ModalManager.closeResize());
    document.getElementById('btnResizeCancel').addEventListener('click', () => ModalManager.closeResize());
    document.getElementById('btnResizeApply').addEventListener('click', () => {
      const percent = units.value === 'percent';
      const w = percent ? Math.round(resizeModal.dataset.width * resizeW.valueAsNumber / 100) : resizeW.valueAsNumber;
      const h = percent ? Math.round(resizeModal.dataset.height * resizeH.valueAsNumber / 100) : resizeH.valueAsNumber;
      const skewX = document.getElementById('skewX').valueAsNumber;
      const skewY = document.getElementById('skewY').valueAsNumber;
      const after = transformedSize(w, h, skewX, skewY);
      if (validSize(w, h) && Math.abs(skewX) < 90 && Math.abs(skewY) < 90 && validSize(after.width, after.height)) {
        CanvasManager.resizeCanvas(w, h, scale.checked, skewX, skewY);
        ModalManager.closeResize();
      } else {
        ToastManager.show('Use dimensions of 1–8000 pixels after skew, and angles between −89° and 89°.', 'warn');
      }
    });

    document.querySelectorAll('.preset-dim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        units.value = 'px';
        scale.disabled = Boolean(SelectionManager.getSelectionBounds?.());
        document.getElementById('resizeWidthInput').value = btn.dataset.w;
        document.getElementById('resizeHeightInput').value = btn.dataset.h;
      });
    });

    // Shortcuts Modal
    document.getElementById('btnShortcutsClose').addEventListener('click', () => ModalManager.closeShortcuts());
    document.getElementById('btnShortcutsDismiss').addEventListener('click', () => ModalManager.closeShortcuts());

    // About Modal
    document.getElementById('btnAboutClose').addEventListener('click', () => ModalManager.closeAbout());
    document.getElementById('btnAboutDismiss').addEventListener('click', () => ModalManager.closeAbout());
  },

  bindQuickActions() {
    // New Board Button in Sidebar
    document.getElementById('btnNewBoard').addEventListener('click', () => {
      BoardManager.createNewBoard();
    });

    // Title board rename click
    document.getElementById('headerBoardName').addEventListener('click', () => {
      const current = BoardManager.getActiveBoard();
      if (current) ModalManager.showRename(current);
    });

    // Quick Undo / Redo / Clear in header
    document.getElementById('btnUndoQuick').addEventListener('click', () => HistoryManager.undo());
    document.getElementById('btnRedoQuick').addEventListener('click', () => HistoryManager.redo());
    document.getElementById('btnClearQuick').addEventListener('click', event => {
      ModalManager.showClearCanvas(BoardManager.getActiveBoard(), event.currentTarget);
    });

    // Bottom Zoom Controls
    document.getElementById('btnZoomIn').addEventListener('click', () => CanvasManager.zoomIn());
    document.getElementById('btnZoomOut').addEventListener('click', () => CanvasManager.zoomOut());
    document.getElementById('btnFitWindowQuick').addEventListener('click', () => CanvasManager.fitToWindow());
    document.getElementById('statusZoomLevel').addEventListener('click', () => CanvasManager.resetZoom());
  },

  bindSidebar() {
    const compact = matchMedia('(max-width: 900px)');
    const sidebar = document.getElementById('sidebarPanel');
    const toggle = document.getElementById('btnToggleSidebar');
    const close = document.getElementById('mobileCloseBtn');
    const backdrop = document.getElementById('mobileBackdrop');
    const syncExpanded = () => {
      const expanded = compact.matches ? sidebar.classList.contains('open') : !sidebar.classList.contains('collapsed');
      toggle.setAttribute('aria-expanded', String(expanded));
    };
    const setDrawer = open => {
      sidebar.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
      this.closeAllMenus();
      syncExpanded();
      (open ? close : toggle).focus({ preventScroll: true });
    };

    toggle.addEventListener('click', () => {
      if (compact.matches) setDrawer(!sidebar.classList.contains('open'));
      else {
        sidebar.classList.toggle('collapsed');
        syncExpanded();
      }
    });
    close.addEventListener('click', () => setDrawer(false));
    backdrop.addEventListener('click', () => setDrawer(false));
    compact.addEventListener('change', () => {
      sidebar.classList.remove('open', 'collapsed');
      backdrop.classList.remove('open');
      this.closeAllMenus();
      syncExpanded();
    });
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || document.querySelector('.app-dialog[open]')) return;
      const menuButton = document.querySelector('.menu-item.active .menu-btn');
      if (menuButton) {
        this.closeAllMenus();
        menuButton.focus();
      } else if (sidebar.classList.contains('open')) setDrawer(false);
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    syncExpanded();
  },

  bindKeyboardShortcuts() {
    const editingControl = event => event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) ||
      document.querySelector('.app-dialog[open]');
    if (/Mac|iPhone|iPad/i.test(navigator.platform)) {
      for (const el of document.querySelectorAll('.shortcut, .shortcut-row .key')) {
        el.textContent = el.textContent.replace(/Ctrl\s*\+\s*Y/g, '⌘+Shift+Z').replace(/Ctrl/g, '⌘');
      }
      for (const el of document.querySelectorAll('[title*="Ctrl"]')) {
        el.title = el.title.replace(/Ctrl\+Y/g, '⌘+Shift+Z').replace(/Ctrl/g, '⌘');
      }
    }
    window.addEventListener('keydown', (e) => {
      if (editingControl(e) || e.defaultPrevented) return;

      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;

      if ((ctrl && key === 'y') || (ctrl && e.shiftKey && key === 'z')) {
        e.preventDefault();
        HistoryManager.redo();
      } else if (ctrl && key === 'z') {
        e.preventDefault();
        HistoryManager.undo();
      } else if (ctrl && e.shiftKey && key === 's') {
        e.preventDefault();
        ImageManager.showSaveAs();
      } else if (ctrl && key === 's') {
        e.preventDefault();
        StorageManager.exportProjectJSON();
      } else if (ctrl && key === 'n') {
        e.preventDefault();
        BoardManager.createNewBoard();
      } else if (ctrl && key === 'p') {
        e.preventDefault();
        ImageManager.print();
      } else if (ctrl && key === 'o') {
        e.preventDefault();
        document.getElementById('fileInputImage').click();
      } else if (ctrl && !e.shiftKey && key === 'c' && AppState.selection.active) {
        e.preventDefault();
        SelectionManager.copy();
      } else if (ctrl && !e.shiftKey && key === 'x' && AppState.selection.active) {
        e.preventDefault();
        SelectionManager.cut();
      } else if (ctrl && e.shiftKey && key === 'i') {
        e.preventDefault();
        SelectionManager.invertSelection();
      } else if (ctrl && e.shiftKey && key === 'x') {
        e.preventDefault();
        CanvasManager.crop();
      } else if (ctrl && key === 'i') {
        e.preventDefault();
        CanvasManager.applyTransform('invert');
      } else if (ctrl && key === 'a') {
        e.preventDefault();
        SelectionManager.selectAll();
      } else if (ctrl && (key === '=' || key === '+')) {
        e.preventDefault();
        CanvasManager.zoomIn();
      } else if (ctrl && key === '-') {
        e.preventDefault();
        CanvasManager.zoomOut();
      } else if (ctrl && key === '0') {
        e.preventDefault();
        CanvasManager.resetZoom();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selection.active) {
        e.preventDefault();
        SelectionManager.deleteSelection();
      } else if (e.key === 'Escape') {
        if (ImageManager.imgRect) ImageManager.cancelImage();
        else if (!ToolManager.cancelPending()) SelectionManager.cancel();
        this.closeAllMenus();
      } else if (e.key === 'Enter') {
        if (ImageManager.imgRect) { e.preventDefault(); ImageManager.placeImage(); }
        else if (ToolManager.finishPending()) e.preventDefault();
        else if (AppState.selection.active && !e.target.closest('button')) { e.preventDefault(); SelectionManager.deselect(); }
      } else if (!ctrl && !e.altKey) {
        switch (key) {
          case 'p': ToolManager.setTool('pencil'); break;
          case 'b': ToolManager.setTool('brush'); break;
          case 'e': ToolManager.setTool('eraser'); break;
          case 'l': ToolManager.setTool('line'); break;
          case 'r': ToolManager.setTool('rectangle'); break;
          case 'c': ToolManager.setTool('circle'); break;
          case 't': ToolManager.setTool('text'); break;
          case 'g': ToolManager.setTool('fill'); break;
          case 'i': ToolManager.setTool('picker'); break;
          case 's': ToolManager.setTool('select'); break;
          case 'h': ToolManager.setTool('pan'); break;
          case 'v': ToolManager.setTool('laser'); break;
          case 'z': ToolManager.setTool('magnifier'); break;
          case 'x': UIManager.swapColors(); break;
          case 'f1':
          case '?':
            ModalManager.showShortcuts();
            break;
        }
      }
    });

    // Space key panning
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName) && !e.target.isContentEditable) {
        CanvasManager.viewport.classList.add('tool-pan');
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && AppState.activeTool !== 'pan') {
        CanvasManager.viewport.classList.remove('tool-pan');
      }
    });

    // Let the browser dispatch native paste, including images copied by other apps.
    window.addEventListener('paste', (e) => {
      if (editingControl(e) || e.defaultPrevented || !CanvasManager.canEdit()) return;
      const data = e.clipboardData;
      const file = [...(data?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile() ||
        [...(data?.files || [])].find(file => file.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        ImageManager.handleImageFile(file, 'paste');
      } else if (AppState.clipboardImageData && (SelectionManager.localClipboard || !data?.types.length)) {
        e.preventDefault();
        SelectionManager.pasteCustom(AppState.clipboardImageData, null, null, SelectionManager.clipboardMask);
      }
    });
  }
};

// =============================================================================
// 13. BOOTSTRAP INITIALIZATION
// =============================================================================
window.addEventListener('DOMContentLoaded', () => {
  ToastManager.init();
  CanvasManager.init();
  TableEditor.init();
  TextManager.init();
  SelectionManager.init();
  ImageManager.init();
  UIManager.init();
  BoardManager.init();
  window.addEventListener('pagehide', () => {
    if (AppState.isSaving) BoardManager.saveCurrentBoardState();
  });
});
