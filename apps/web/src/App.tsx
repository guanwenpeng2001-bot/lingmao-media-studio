import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { CashierDrawer } from './components/CashierDrawer';
import { CreateProjectModal } from './components/CreateProjectModal';
import { InsufficientCreditsModal } from './components/InsufficientCreditsModal';
import { LoginModal } from './components/LoginModal';
import { ShortcutsModal } from './components/ShortcutsModal';
import { TaskDrawer } from './components/TaskDrawer';
import { ToastContainer } from './components/ToastContainer';
import { AssetsPage } from './features/assets/AssetsPage';
import { BillingPage } from './features/billing/BillingPage';
import { CanvasEditorPage } from './features/canvases/CanvasEditorPage';
import { CanvasListPage } from './features/canvases/CanvasListPage';
import { EcommercePage } from './features/ecommerce/EcommercePage';
import { ExplorePage } from './features/explore/ExplorePage';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { StudioPage } from './features/studio/StudioPage';
import { TasksPage } from './features/tasks/TasksPage';
import { AppProvider, useApp } from './state/AppContext';

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
      <Route path="/org" element={<OrgFeatureGuard />} />
      <Route path="*" element={<Navigate to="/explore" replace />} />
    </Routes>

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
