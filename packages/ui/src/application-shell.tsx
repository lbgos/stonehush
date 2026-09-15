import { ChevronDown, ChevronUp, Menu, PanelLeftClose, PanelLeftOpen, Terminal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "./cn.js";
import { ConsoleTabs, type ConsolePanel } from "./console-tabs.js";
import { FullScreenSheet } from "./full-screen-sheet.js";
import {
  CONSOLE_HEIGHT_STORAGE_KEY,
  DEFAULT_CONSOLE_HEIGHT,
  DEFAULT_SIDEBAR_WIDTH,
  DESKTOP_BREAKPOINT,
  MIN_CONSOLE_HEIGHT,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_OPEN_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampConsoleHeight,
  clampSidebarWidth,
  getLayoutStorage,
  readStoredBoolean,
  readStoredNumber,
  writeStoredValue,
} from "./layout.js";
import { usePointerResize } from "./use-pointer-resize.js";

type CloseMobile = () => void;
type ShellSlot = ReactNode | ((closeMobile: CloseMobile) => ReactNode);

export interface ApplicationShellProps {
  children: ReactNode;
  consolePanels: readonly ConsolePanel[];
  consoleStatus?: ReactNode;
  mobileTitle?: string;
  /** Brand element in the mobile top bar. Defaults to plain "Stonehush" text. */
  mobileBrand?: ReactNode;
  /** Renders the bottom console and its mobile trigger. Defaults to true. */
  showConsole?: boolean;
  /** Renders the desktop stage header row. Mobile navigation always stays. Defaults to true. */
  showDesktopStageHeader?: boolean;
  sidebarActions?: ShellSlot;
  sidebarContent: ShellSlot;
  sidebarFooter: ShellSlot;
  sidebarHeader: ReactNode;
  stageHeader?: ReactNode;
}

interface ShellStyle extends CSSProperties {
  "--shell-console-height": string;
  "--shell-sidebar-width": string;
}

const KEYBOARD_RESIZE_STEP = 16;

function renderSlot(slot: ShellSlot, closeMobile: CloseMobile): ReactNode {
  return typeof slot === "function" ? slot(closeMobile) : slot;
}

function SidebarFrame({
  actions,
  content,
  footer,
  header,
}: {
  actions?: ReactNode;
  content: ReactNode;
  footer: ReactNode;
  header: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="shrink-0">{header}</div>
      {actions != null && (
        <div
          className="shrink-0 border-y border-sidebar-border"
          data-testid="sidebar-actions"
        >
          {actions}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{content}</div>
      <div className="shrink-0 border-t border-sidebar-border">{footer}</div>
    </div>
  );
}

export function ApplicationShell({
  children,
  consolePanels,
  consoleStatus = "Console ready",
  mobileBrand,
  mobileTitle = "Stonehush navigation",
  showConsole = true,
  showDesktopStageHeader = true,
  sidebarActions,
  sidebarContent,
  sidebarFooter,
  sidebarHeader,
  stageHeader,
}: ApplicationShellProps) {
  const storage = getLayoutStorage(window);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(() =>
    readStoredBoolean(storage, SIDEBAR_OPEN_STORAGE_KEY, true),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebarWidth(
      readStoredNumber(storage, SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH),
      window.innerWidth,
    ),
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [desktopConsoleCollapsed, setDesktopConsoleCollapsed] = useState(false);
  const [mobileConsoleOpen, setMobileConsoleOpen] = useState(false);
  const [desktopViewport, setDesktopViewport] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const [consoleHeight, setConsoleHeight] = useState(() =>
    clampConsoleHeight(
      readStoredNumber(storage, CONSOLE_HEIGHT_STORAGE_KEY, DEFAULT_CONSOLE_HEIGHT),
      window.innerHeight,
    ),
  );
  const wasDesktop = useRef(window.innerWidth >= DESKTOP_BREAKPOINT);
  const desktopSidebarToggle = useRef<HTMLButtonElement>(null);
  const desktopConsole = useRef<HTMLElement>(null);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const renderedDesktopContent = useMemo(
    () => renderSlot(sidebarContent, closeMobileNav),
    [closeMobileNav, sidebarContent],
  );
  const renderedDesktopFooter = useMemo(
    () => renderSlot(sidebarFooter, closeMobileNav),
    [closeMobileNav, sidebarFooter],
  );

  useEffect(() => {
    writeStoredValue(storage, SIDEBAR_OPEN_STORAGE_KEY, desktopSidebarOpen);
    document.documentElement.dataset.sidebarOpen = String(desktopSidebarOpen);
  }, [desktopSidebarOpen, storage]);

  useEffect(() => {
    if (window.innerWidth < DESKTOP_BREAKPOINT) return;
    writeStoredValue(storage, SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth);
    document.documentElement.style.setProperty("--shell-sidebar-width", `${sidebarWidth}px`);
  }, [sidebarWidth, storage]);

  useEffect(() => {
    if (window.innerWidth < DESKTOP_BREAKPOINT) return;
    writeStoredValue(storage, CONSOLE_HEIGHT_STORAGE_KEY, consoleHeight);
    document.documentElement.style.setProperty("--shell-console-height", `${consoleHeight}px`);
  }, [consoleHeight, storage]);

  useEffect(() => {
    const onResize = () => {
      const isDesktop = window.innerWidth >= DESKTOP_BREAKPOINT;
      const wasDesktopViewport = wasDesktop.current;
      setDesktopViewport(isDesktop);
      if (isDesktop && !wasDesktopViewport) {
        setMobileNavOpen(false);
        setMobileConsoleOpen(false);
      }
      if (isDesktop) {
        setSidebarWidth((current) =>
          clampSidebarWidth(
            wasDesktopViewport
              ? current
              : readStoredNumber(storage, SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH),
            window.innerWidth,
          ),
        );
        setConsoleHeight((current) =>
          clampConsoleHeight(
            wasDesktopViewport
              ? current
              : readStoredNumber(storage, CONSOLE_HEIGHT_STORAGE_KEY, DEFAULT_CONSOLE_HEIGHT),
            window.innerHeight,
          ),
        );
      } else {
        setSidebarWidth((current) => clampSidebarWidth(current, window.innerWidth));
        setConsoleHeight((current) => clampConsoleHeight(current, window.innerHeight));
      }
      wasDesktop.current = isDesktop;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [storage]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "b" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        window.innerWidth < DESKTOP_BREAKPOINT
      ) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest("[data-keybinding-capture]")) return;
      event.preventDefault();
      setDesktopSidebarOpen((current) => !current);
    };
    window.addEventListener("keydown", onShortcut, { capture: true });
    return () => window.removeEventListener("keydown", onShortcut, { capture: true });
  }, []);

  const sidebarResize = usePointerResize({
    axis: "x",
    clamp: useCallback((value: number) => clampSidebarWidth(value, window.innerWidth), []),
    cursor: "col-resize",
    onChange: setSidebarWidth,
    value: sidebarWidth,
  });
  const consoleResize = usePointerResize({
    axis: "y",
    clamp: useCallback((value: number) => clampConsoleHeight(value, window.innerHeight), []),
    cursor: "row-resize",
    direction: -1,
    onChange: setConsoleHeight,
    value: consoleHeight,
  });
  const { abortResize: abortSidebarResize, ...sidebarResizeHandlers } = sidebarResize;
  const { abortResize: abortConsoleResize, ...consoleResizeHandlers } = consoleResize;

  useEffect(() => {
    if (!desktopSidebarOpen || !desktopViewport) abortSidebarResize();
  }, [abortSidebarResize, desktopSidebarOpen, desktopViewport]);

  useEffect(() => {
    if (desktopConsoleCollapsed || !desktopViewport) abortConsoleResize();
  }, [abortConsoleResize, desktopConsoleCollapsed, desktopViewport]);

  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    let next: ((current: number) => number) | undefined;
    if (event.key === "ArrowLeft") next = (current) => current - KEYBOARD_RESIZE_STEP;
    if (event.key === "ArrowRight") next = (current) => current + KEYBOARD_RESIZE_STEP;
    if (event.key === "Home") next = () => MIN_SIDEBAR_WIDTH;
    if (event.key === "End") next = () => Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 640);
    if (!next) return;
    event.preventDefault();
    setSidebarWidth((current) => clampSidebarWidth(next(current), window.innerWidth));
  }, []);

  const resizeConsoleWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    let next: ((current: number) => number) | undefined;
    if (event.key === "ArrowDown") next = (current) => current - KEYBOARD_RESIZE_STEP;
    if (event.key === "ArrowUp") next = (current) => current + KEYBOARD_RESIZE_STEP;
    if (event.key === "Home") next = () => MIN_CONSOLE_HEIGHT;
    if (event.key === "End") next = () => Math.max(MIN_CONSOLE_HEIGHT, window.innerHeight * 0.6);
    if (!next) return;
    event.preventDefault();
    setConsoleHeight((current) => clampConsoleHeight(next(current), window.innerHeight));
  }, []);

  const style: ShellStyle = {
    "--shell-console-height": `${consoleHeight}px`,
    "--shell-sidebar-width": `${sidebarWidth}px`,
  };

  return (
    <div
      className="application-shell h-dvh min-h-0 overflow-hidden bg-background text-foreground"
      data-sidebar-open={desktopSidebarOpen}
      data-testid="application-shell"
      style={style}
    >
      <aside
        aria-hidden={!desktopSidebarOpen}
        aria-label="Primary"
        className="shell-sidebar fixed inset-y-0 z-30 hidden border-r border-sidebar-border md:block"
        inert={!desktopSidebarOpen ? true : undefined}
      >
        <SidebarFrame
          header={sidebarHeader}
          actions={renderSlot(sidebarActions, closeMobileNav)}
          content={renderedDesktopContent}
          footer={renderedDesktopFooter}
        />
        {desktopSidebarOpen && (
          <div
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemax={Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - 640)}
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuenow={Math.round(sidebarWidth)}
            className="shell-sidebar-resize absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 cursor-col-resize touch-none outline-none focus-visible:bg-ring/30 focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={resizeSidebarWithKeyboard}
            role="separator"
            tabIndex={0}
            {...sidebarResizeHandlers}
          />
        )}
      </aside>

      <div className="shell-workspace flex h-dvh min-w-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2 pt-[env(safe-area-inset-top)] md:hidden">
          <FullScreenSheet
            description="Global navigation and Stonehush settings."
            onOpenChange={setMobileNavOpen}
            onOpenChangeComplete={(open) => {
              if (!open && window.innerWidth >= DESKTOP_BREAKPOINT) {
                desktopSidebarToggle.current?.focus();
              }
            }}
            open={mobileNavOpen}
            title={mobileTitle}
            trigger={<Menu className="size-4" aria-hidden="true" />}
            triggerLabel="Open navigation"
          >
            <SidebarFrame
              header={sidebarHeader}
              actions={renderSlot(sidebarActions, closeMobileNav)}
              content={renderSlot(sidebarContent, closeMobileNav)}
              footer={renderSlot(sidebarFooter, closeMobileNav)}
            />
          </FullScreenSheet>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.03em]">
            {mobileBrand ?? "Stonehush"}
          </span>
          {showConsole && (
            <FullScreenSheet
              description="Advisor, activity, and raw output views."
              onOpenChange={setMobileConsoleOpen}
              onOpenChangeComplete={(open) => {
                if (!open && window.innerWidth >= DESKTOP_BREAKPOINT) desktopConsole.current?.focus();
              }}
              open={mobileConsoleOpen}
              title="Console"
              trigger={<Terminal className="size-4" aria-hidden="true" />}
              triggerLabel="Open console"
            >
              <ConsoleTabs panels={consolePanels} />
            </FullScreenSheet>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-pane">
          {showDesktopStageHeader && (
            <header className="shell-stage-header flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-2 py-1 md:h-12 md:flex-nowrap md:px-3 md:py-0">
              <button
                ref={desktopSidebarToggle}
                type="button"
                aria-keyshortcuts="Control+B Meta+B"
                aria-label={desktopSidebarOpen ? "Hide sidebar" : "Show sidebar"}
                aria-pressed={desktopSidebarOpen}
                className="shell-sidebar-toggle hidden size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:inline-flex md:size-8"
                onClick={() => setDesktopSidebarOpen((current) => !current)}
                title={`${desktopSidebarOpen ? "Hide" : "Show"} sidebar (Mod+B)`}
              >
                {desktopSidebarOpen ? (
                  <PanelLeftClose className="size-4" aria-hidden="true" />
                ) : (
                  <PanelLeftOpen className="size-4" aria-hidden="true" />
                )}
              </button>
              <div className="flex min-h-11 min-w-0 flex-1 items-center md:min-h-8">
                {stageHeader}
              </div>
            </header>
          )}
          {/* The workspace pane scrolls within its own flex allocation; the console pane below
              never participates in that scroll, so content is clipped here instead of behind it. */}
          <div
            className="min-h-0 flex-1 overflow-auto overscroll-contain"
            data-testid="workspace-scroll-region"
          >
            {children}
          </div>
        </div>

        {showConsole && (
            <section
              ref={desktopConsole}
              aria-label="Console"
              className={cn(
                "shell-console relative hidden shrink-0 border-t border-border bg-background md:block",
                desktopConsoleCollapsed && "shell-console-collapsed",
              )}
              tabIndex={-1}
            >
            {!desktopConsoleCollapsed && (
              <div
                aria-label="Resize console"
                aria-orientation="horizontal"
                aria-valuemax={Math.max(MIN_CONSOLE_HEIGHT, window.innerHeight * 0.6)}
                aria-valuemin={MIN_CONSOLE_HEIGHT}
                aria-valuenow={Math.round(consoleHeight)}
                className="absolute inset-x-0 top-0 z-10 h-2 -translate-y-1/2 cursor-row-resize touch-none outline-none focus-visible:bg-ring/30 focus-visible:ring-2 focus-visible:ring-ring"
                onKeyDown={resizeConsoleWithKeyboard}
                role="separator"
                tabIndex={0}
                {...consoleResizeHandlers}
              />
            )}
            {desktopConsoleCollapsed ? (
              <div className="flex h-11 items-center gap-3 px-4 text-[13px] text-muted-foreground">
                <Terminal className="size-4" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{consoleStatus}</span>
                <button
                  type="button"
                  aria-label="Expand console"
                  className="inline-flex size-11 items-center justify-center rounded-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:size-8"
                  onClick={() => setDesktopConsoleCollapsed(false)}
                >
                  <ChevronUp className="size-4" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="relative h-full min-h-0">
                <button
                  type="button"
                  aria-label="Collapse console"
                  className="absolute top-0 right-2 z-20 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:size-8"
                  onClick={() => setDesktopConsoleCollapsed(true)}
                >
                  <ChevronDown className="size-4" aria-hidden="true" />
                </button>
                <ConsoleTabs panels={consolePanels} />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
