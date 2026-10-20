/** Undo / redo stack shared by the Transform and Sculpt tools (Ctrl+Z / Ctrl+Y). */
export interface HistoryEntry {
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly limit = 30) {}

  /** Record an action that has already been applied. */
  push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this.emit();
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this.emit();
    return e.label;
  }

  /** Drop entries that refer to an object that no longer exists. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}
