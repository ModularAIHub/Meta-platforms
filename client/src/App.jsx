import React, { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { AccountProvider } from './contexts/AccountContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import Layout from './components/Layout';
import LoadingSpinner from './components/LoadingSpinner';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const CreatePostPage = lazy(() => import('./pages/CreatePostPage'));
const SchedulePage = lazy(() => import('./pages/SchedulePage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const ConnectedAccountsPage = lazy(() => import('./pages/ConnectedAccountsPage'));
const AuthCallbackPage = lazy(() => import('./pages/AuthCallbackPage'));

const PageLoader = () => (
  <div className="flex items-center justify-center min-h-96">
    <LoadingSpinner size="lg" />
  </div>
);

function App() {
  return (
    <AuthProvider>
      <AccountProvider>
        <Routes>
          <Route
            path="/auth/callback"
            element={
              <Suspense fallback={<PageLoader />}>
                <AuthCallbackPage />
              </Suspense>
            }
          />

          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <Layout>
                  <Suspense fallback={<PageLoader />}>
                    <Routes>
                      <Route path="/" element={<Navigate to="/dashboard" replace />} />
                      <Route path="/dashboard" element={<DashboardPage />} />
                      <Route path="/create-post" element={<CreatePostPage />} />
                      <Route path="/schedule" element={<SchedulePage />} />
                      <Route path="/history" element={<HistoryPage />} />
                      <Route path="/analytics" element={<AnalyticsPage />} />
                      <Route path="/accounts" element={<ConnectedAccountsPage />} />
                    </Routes>
                  </Suspense>
                </Layout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AccountProvider>
    </AuthProvider>
  );
}

export default App;
