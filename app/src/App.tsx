import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAppAuth } from './lib/auth.tsx';
import { ROUTES } from './constants/routes';
import { AppShell } from './components/AppShell';
import { LandingPage } from './pages/LandingPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { SurveysListPage } from './pages/SurveysListPage';
import { SurveyCreationPage } from './pages/SurveyCreationPage';
import { SurveyBuilderPage } from './pages/SurveyBuilderPage';
import { ResponseDashboardPage } from './pages/ResponseDashboardPage';
import { SurveyInsightsPage }    from './pages/SurveyInsightsPage';
import { SampleResponsesPage }  from './pages/SampleResponsesPage';
import { InsightsDashboardPage } from './pages/InsightsDashboardPage';
import { TopicsAnalysisPage } from './pages/insights/TopicsAnalysisPage';
import { InsightTrailPage } from './pages/insights/InsightTrailPage';
import { InsightReportPage } from './pages/insights/InsightReportPage';
import { InsightSettingsPage } from './pages/insights/InsightSettingsPage';
import { CustomAnalysisPage } from './pages/insights/CustomAnalysisPage';
import { CustomReportPage } from './pages/insights/CustomReportPage';
import { AdvancedInsightsPage } from './pages/AdvancedInsightsPage';
import { InsightsBriefPage } from './pages/insights/InsightsBriefPage';
import { InsightsMetricsPage } from './pages/insights/InsightsMetricsPage';
import { InsightsFindingsPage } from './pages/insights/InsightsFindingsPage';
import { InsightsSurfacedPage } from './pages/insights/InsightsSurfacedPage';
import { ResponseCollectionPage } from './pages/ResponseCollectionPage';
import { BrandSettingsPage } from './pages/BrandSettingsPage';
import { TemplateLibraryPage } from './pages/TemplateLibraryPage';
import { TemplateEditorPage } from './pages/TemplateEditorPage';
import { WorkflowsPage } from './pages/WorkflowsPage';
import { WorkflowBuilderPage } from './pages/WorkflowBuilderPage';
import { WorkflowCanvasPage } from './pages/WorkflowCanvasPage';
import { WorkflowNLBuilderPage } from './pages/WorkflowNLBuilderPage';
import { DataPage } from './pages/DataPage';
import { PrismHomePage } from './pages/prism/PrismHomePage';
import { PrismConnectPage } from './pages/prism/PrismConnectPage';
import { PrismJobPage } from './pages/prism/PrismJobPage';
import { PrismJobsPage } from './pages/prism/PrismJobsPage';
import { ExperienceHubPage } from './pages/experience/ExperienceHubPage';
import { SurveyIntelligencePage } from './pages/experience/SurveyIntelligencePage';
import { SurveyReportPage } from './pages/experience/SurveyReportPage';
import { TopicAnalysisHubPage } from './pages/experience/TopicAnalysisHubPage';
import { TopicDeepDivePage } from './pages/experience/TopicDeepDivePage';
import { SurveyTrendsPage } from './pages/experience/SurveyTrendsPage';
import { OrgTrendsPage } from './pages/experience/OrgTrendsPage';
import { TagReportsIndexPage } from './pages/experience/TagReportsIndexPage';
import { TagReportNewPage } from './pages/experience/TagReportNewPage';
import { TagReportPage } from './pages/experience/TagReportPage';
import { TagReportTrailPage } from './pages/experience/TagReportTrailPage';
import { ResponseDetailPage } from './pages/ResponseDetailPage';
import { SignInPage } from './pages/SignInPage';
import { SurveyFillPage } from './pages/SurveyFillPage';
import { ErrorPage } from './pages/ErrorPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BrandProvider } from './contexts/brandContext';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { ContactSegmentsPage } from './pages/ContactSegmentsPage';
import { CasesPage } from './pages/CasesPage';
import { CaseDetailPage } from './pages/CaseDetailPage';
import { OwnershipRoutingPage } from './pages/OwnershipRoutingPage';
import { SettingsConnectionsPage } from './pages/SettingsConnectionsPage';
import { IntegrationsSettingsPage } from './pages/settings/IntegrationsSettingsPage';
import { NotificationAnalyticsPage } from './pages/NotificationAnalyticsPage';
import { BillingPage } from './pages/BillingPage';
import { BroadcastsPage } from './pages/BroadcastsPage';
import { BroadcastApprovalPage } from './pages/BroadcastApprovalPage';
import { DocPipelinePage } from './pages/admin/DocPipelinePage';
import { DocReviewPage } from './pages/admin/DocReviewPage';
import { DocEditorPage } from './pages/admin/DocEditorPage';
import { DocGapsPage } from './pages/admin/DocGapsPage';
import { PipelineStatsPage } from './pages/admin/PipelineStatsPage';
import { AdminCrystalSkillsPage } from './pages/admin/AdminCrystalSkillsPage';
import { AdminCrystalSkillDetailPage } from './pages/admin/AdminCrystalSkillDetailPage';
import { AdminCrystalQualityPage } from './pages/admin/AdminCrystalQualityPage';
import { AdminCrystalSignalsPage } from './pages/admin/AdminCrystalSignalsPage';
import { AdminCrystalGapsPage } from './pages/admin/AdminCrystalGapsPage';
import { AdminCrystalDlqPage } from './pages/admin/AdminCrystalDlqPage';

function ProtectedRoute() {
  const { isSignedIn, isLoaded, orgId } = useAppAuth();
  const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  const location = useLocation();

  if (clerkKey && !isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
      </div>
    );
  }
  if (clerkKey && !isSignedIn) {
    return <Navigate to={ROUTES.SIGNIN} state={{ from: location }} replace />;
  }
  // Signed in but no active organization → the JWT carries no org_id/org_role, so
  // every write (requireRole) would 403. Send the user to onboarding to pick/create
  // an org (which calls setActive, scoping the session token).
  if (clerkKey && isSignedIn && !orgId) {
    return <Navigate to={ROUTES.ONBOARDING} state={{ from: location }} replace />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        {/* ── Public routes — each page gets its own full-screen boundary ── */}
        <Route path={ROUTES.LANDING}    element={<ErrorBoundary><LandingPage /></ErrorBoundary>} />
        <Route path={ROUTES.SIGNIN}     element={<ErrorBoundary><SignInPage /></ErrorBoundary>} />
        <Route path={ROUTES.ONBOARDING} element={<ErrorBoundary><OnboardingPage /></ErrorBoundary>} />
        <Route path="/s/:token"         element={<ErrorBoundary><SurveyFillPage /></ErrorBoundary>} />

        {/* ── Protected routes ── */}
        <Route element={<ProtectedRoute />}>

          {/* All app pages: wrapped in AppShell + inline boundary per page
              so a single page crash never breaks the nav or other pages */}
          <Route element={<BrandProvider><AppShell /></BrandProvider>}>
            <Route path={ROUTES.BUILDER}            element={<ErrorBoundary inline><SurveyBuilderPage /></ErrorBoundary>} />
            <Route path={ROUTES.SURVEYS}            element={<ErrorBoundary inline><SurveysListPage /></ErrorBoundary>} />
            <Route path={ROUTES.CREATE}             element={<ErrorBoundary inline><SurveyCreationPage /></ErrorBoundary>} />
            <Route path={ROUTES.RESPONSE_DASHBOARD} element={<ErrorBoundary inline><ResponseDashboardPage /></ErrorBoundary>} />
            <Route path={ROUTES.SURVEY_INSIGHTS}    element={<ErrorBoundary inline><SurveyInsightsPage /></ErrorBoundary>} />
            <Route path={ROUTES.SAMPLE_RESPONSES}   element={<ErrorBoundary inline><SampleResponsesPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHTS}           element={<ErrorBoundary inline><InsightsDashboardPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHTS_TOPICS}    element={<ErrorBoundary inline><TopicsAnalysisPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHT_TRAIL}      element={<ErrorBoundary inline><InsightTrailPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHT_REPORT}     element={<ErrorBoundary inline><InsightReportPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHT_SETTINGS}   element={<ErrorBoundary inline><InsightSettingsPage /></ErrorBoundary>} />
            <Route path={ROUTES.CUSTOM_ANALYSIS}    element={<ErrorBoundary inline><CustomAnalysisPage /></ErrorBoundary>} />
            <Route path={ROUTES.CUSTOM_REPORT}      element={<ErrorBoundary inline><CustomReportPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADVANCED_INSIGHTS}  element={<ErrorBoundary inline><AdvancedInsightsPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHTS_BRIEF}     element={<ErrorBoundary inline><InsightsBriefPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHTS_METRICS}   element={<ErrorBoundary inline><InsightsMetricsPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHTS_FINDINGS}  element={<ErrorBoundary inline><InsightsFindingsPage /></ErrorBoundary>} />
            <Route path={ROUTES.INSIGHTS_SURFACED}  element={<ErrorBoundary inline><InsightsSurfacedPage /></ErrorBoundary>} />
            <Route path={ROUTES.RESPONDENTS}        element={<ErrorBoundary inline><ResponseCollectionPage /></ErrorBoundary>} />
            <Route path={ROUTES.TEMPLATES}          element={<ErrorBoundary inline><TemplateLibraryPage /></ErrorBoundary>} />
            <Route path={ROUTES.TEMPLATE_EDITOR}    element={<ErrorBoundary inline><TemplateEditorPage /></ErrorBoundary>} />
            <Route path={ROUTES.WORKFLOWS}          element={<ErrorBoundary inline><WorkflowsPage /></ErrorBoundary>} />
            <Route path={ROUTES.WORKFLOW_BUILD}     element={<ErrorBoundary inline><WorkflowBuilderPage /></ErrorBoundary>} />
            <Route path={ROUTES.WORKFLOW_CANVAS}    element={<ErrorBoundary inline><WorkflowCanvasPage /></ErrorBoundary>} />
            <Route path={ROUTES.WORKFLOW_NL_BUILD}  element={<ErrorBoundary inline><WorkflowNLBuilderPage /></ErrorBoundary>} />
            <Route path={ROUTES.SETTINGS}           element={<ErrorBoundary inline><BrandSettingsPage /></ErrorBoundary>} />
            <Route path={ROUTES.DATA}               element={<ErrorBoundary inline><DataPage /></ErrorBoundary>} />

            {/* Prism — ingestion / migration wizard */}
            <Route path={ROUTES.PRISM}         element={<ErrorBoundary inline><PrismHomePage /></ErrorBoundary>} />
            <Route path={ROUTES.PRISM_CONNECT} element={<ErrorBoundary inline><PrismConnectPage /></ErrorBoundary>} />
            <Route path={ROUTES.PRISM_JOBS}    element={<ErrorBoundary inline><PrismJobsPage /></ErrorBoundary>} />
            <Route path={ROUTES.PRISM_JOB}     element={<ErrorBoundary inline><PrismJobPage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE}              element={<ErrorBoundary inline><ExperienceHubPage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE_ORG_TRENDS}   element={<ErrorBoundary inline><OrgTrendsPage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE_SURVEY}       element={<ErrorBoundary inline><SurveyIntelligencePage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE_SURVEY_REPORT} element={<ErrorBoundary inline><SurveyReportPage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE_SURVEY_TOPICS} element={<ErrorBoundary inline><TopicAnalysisHubPage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE_SURVEY_TOPIC}  element={<ErrorBoundary inline><TopicDeepDivePage /></ErrorBoundary>} />
            <Route path={ROUTES.EXPERIENCE_SURVEY_TRENDS} element={<ErrorBoundary inline><SurveyTrendsPage /></ErrorBoundary>} />

            {/* Tag Report — cross-survey AI insight rollups (nested under Experience) */}
            <Route path={ROUTES.TAG_REPORTS_INDEX} element={<ErrorBoundary inline><TagReportsIndexPage /></ErrorBoundary>} />
            <Route path={ROUTES.TAG_REPORT_TRAIL}  element={<ErrorBoundary inline><TagReportTrailPage /></ErrorBoundary>} />
            <Route path={ROUTES.TAG_REPORT_NEW}    element={<ErrorBoundary inline><TagReportNewPage /></ErrorBoundary>} />
            <Route path={ROUTES.TAG_REPORT_LATEST} element={<ErrorBoundary inline><TagReportPage /></ErrorBoundary>} />
            <Route path={ROUTES.TAG_REPORT}        element={<ErrorBoundary inline><TagReportPage /></ErrorBoundary>} />
            <Route path={ROUTES.RESPONSE_DETAIL}   element={<ErrorBoundary inline><ResponseDetailPage /></ErrorBoundary>} />

            {/* Tier 3 — Closed-Loop Action Platform */}
            <Route path={ROUTES.CONTACTS}            element={<ErrorBoundary inline><ContactsPage /></ErrorBoundary>} />
            <Route path={ROUTES.CONTACT_DETAIL}      element={<ErrorBoundary inline><ContactDetailPage /></ErrorBoundary>} />
            <Route path={ROUTES.CONTACT_SEGMENTS}    element={<ErrorBoundary inline><ContactSegmentsPage /></ErrorBoundary>} />
            <Route path={ROUTES.CASES}               element={<ErrorBoundary inline><CasesPage /></ErrorBoundary>} />
            <Route path={ROUTES.CASE_DETAIL}         element={<ErrorBoundary inline><CaseDetailPage /></ErrorBoundary>} />
            <Route path={ROUTES.SETTINGS_OWNERSHIP}     element={<ErrorBoundary inline><OwnershipRoutingPage /></ErrorBoundary>} />
            <Route path={ROUTES.SETTINGS_CONNECTIONS}   element={<ErrorBoundary inline><SettingsConnectionsPage /></ErrorBoundary>} />
            <Route path={ROUTES.SETTINGS_INTEGRATIONS}  element={<ErrorBoundary inline><IntegrationsSettingsPage /></ErrorBoundary>} />
            <Route path={ROUTES.NOTIFICATION_ANALYTICS} element={<ErrorBoundary inline><NotificationAnalyticsPage /></ErrorBoundary>} />
            <Route path={ROUTES.BILLING}                element={<ErrorBoundary inline><BillingPage /></ErrorBoundary>} />
            <Route path={ROUTES.BROADCASTS}          element={<ErrorBoundary inline><BroadcastsPage /></ErrorBoundary>} />
            <Route path={ROUTES.BROADCASTS_APPROVAL} element={<ErrorBoundary inline><BroadcastApprovalPage /></ErrorBoundary>} />

            {/* Admin — Crystal */}
            <Route path={ROUTES.ADMIN_CRYSTAL} element={<Navigate to={ROUTES.ADMIN_CRYSTAL_SKILLS} replace />} />
            <Route path={ROUTES.ADMIN_CRYSTAL_SKILLS}       element={<ErrorBoundary inline><AdminCrystalSkillsPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_CRYSTAL_SKILL_DETAIL} element={<ErrorBoundary inline><AdminCrystalSkillDetailPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_CRYSTAL_QUALITY}      element={<ErrorBoundary inline><AdminCrystalQualityPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_CRYSTAL_SIGNALS}      element={<ErrorBoundary inline><AdminCrystalSignalsPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_CRYSTAL_GAPS}        element={<ErrorBoundary inline><AdminCrystalGapsPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_CRYSTAL_DLQ}         element={<ErrorBoundary inline><AdminCrystalDlqPage /></ErrorBoundary>} />

            {/* Admin — Support Pipeline */}
            <Route path={ROUTES.ADMIN_SUPPORT_PIPELINE} element={<ErrorBoundary inline><DocPipelinePage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_SUPPORT_REVIEW}   element={<ErrorBoundary inline><DocReviewPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_SUPPORT_EDIT}     element={<ErrorBoundary inline><DocEditorPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_SUPPORT_GAPS}     element={<ErrorBoundary inline><DocGapsPage /></ErrorBoundary>} />
            <Route path={ROUTES.ADMIN_SUPPORT_STATS}    element={<ErrorBoundary inline><PipelineStatsPage /></ErrorBoundary>} />
          </Route>

          <Route path="/app" element={<Navigate to={ROUTES.SURVEYS} replace />} />
        </Route>

        <Route path="*" element={<ErrorPage type="not-found" />} />
      </Routes>
    </ErrorBoundary>
  );
}
