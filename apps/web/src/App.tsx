import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { CashierDrawer } from './components/CashierDrawer';
import { CreateProjectModal } from './components/CreateProjectModal';
import { InsufficientCreditsModal } from './components/InsufficientCreditsModal';
import { LoginModal } from './components/LoginModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { TaskDrawer } from './components/TaskDrawer';
import { ToastContainer } from './components/ToastContainer';
import { AppProvider, useApp } from './state/AppContext';

const ExplorePage = lazy(() =>
  import('./features/explore/ExplorePage').then((m) => ({ default: m.ExplorePage }))
);
const StudioPage = lazy(() =>
  import('./features/studio/StudioPage').then((m) => ({ default: m.StudioPage }))
);
const CanvasListPage = lazy(() =>
  import('./features/canvases/CanvasListPage').then((m) => ({ default: m.CanvasListPage }))
);
const CanvasEditorPage = lazy(() =>
  import('./features/canvases/CanvasEditorPage').then((m) => ({ default: m.CanvasEditorPage }))
);
const EcommercePage = lazy(() =>
  import('./features/ecommerce/EcommercePage').then((m) => ({ default: m.EcommercePage }))
);
const ProjectsPage = lazy(() =>
  import('./features/projects/ProjectsPage').then((m) => ({ default: m.ProjectsPage }))
);
const AssetsPage = lazy(() =>
  import('./features/assets/AssetsPage').then((m) => ({ default: m.AssetsPage }))
);
const TasksPage = lazy(() =>
  import('./features/tasks/TasksPage').then((m) => ({ default: m.TasksPage }))
);
const BillingPage = lazy(() =>
  import('./features/billing/BillingPage').then((m) => ({ default: m.BillingPage }))
);
const CheckoutPage = lazy(() =>
  import('./features/billing/CheckoutPage').then((m) => ({ default: m.CheckoutPage }))
);

const RouteLoadingFallback: React.FC = () => (
  <div className="p-6 space-y-4 max-w-[1280px] mx-auto" aria-busy="true">
    <div className="h-8 w-56 rounded-md skeleton-shimmer" />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div className="h-40 rounded-xl skeleton-shimmer" />
      <div className="h-40 rounded-xl skeleton-shimmer" />
      <div className="h-40 rounded-xl skeleton-shimmer" />
    </div>
  </div>
);

const OrgFeatureGuard: React.FC = () => {
  const { features } = useApp();
  if (!features.org_collaboration) {
    return (
      <div className="mx-auto max-w-lg p-12 text-center space-y-3">
        <h2 className="text-base font-semibold text-ink-primary">组织协作空间将在 P1 阶段开放</h2>
        <p className="text-xs text-ink-tertiary">
          当前处于 P0 个人空间版本（org_collaboration=false），您的个人项目、画布、资产与多额度池已完整就绪。
        </p>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-3">
      <h1 className="text-xl font-semibold text-ink-primary">组织与团队空间管理</h1>
      <p className="text-xs text-ink-tertiary">管理团队成员角色（管理员 / 编辑者 / 只读者）与共享积分池。</p>
    </div>
  );
};

export const AppRoutes: React.FC = () => (
  <AppShell>
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/explore" replace />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/canvases" element={<CanvasListPage />} />
        <Route path="/canvases/:canvasId" element={<CanvasEditorPage />} />
        <Route path="/ecommerce" element={<EcommercePage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/billing/plans" element={<BillingPage />} />
        <Route path="/billing/checkout/:checkoutId" element={<CheckoutPage />} />
        <Route path="/org" element={<OrgFeatureGuard />} />
        <Route path="*" element={<Navigate to="/explore" replace />} />
      </Routes>
    </Suspense>

    <LoginModal />
    <CashierDrawer />
    <InsufficientCreditsModal />
    <TaskDrawer />
    <ShortcutsModal />
    <CreateProjectModal />
    <ToastContainer />
  </AppShell>
);

export const App: React.FC = () => (
  <BrowserRouter>
    <AppProvider>
      <AppRoutes />
    </AppProvider>
  </BrowserRouter>
);

export default App;
