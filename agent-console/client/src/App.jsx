import { Link, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import { EmptyState } from "./components/Bits.jsx";
import { Button } from "./components/ui/button.jsx";
import { AgentDetailPage } from "./pages/AgentDetailPage.jsx";
import { AgentFormPage } from "./pages/AgentFormPage.jsx";
import { AgentsPage } from "./pages/AgentsPage.jsx";
import { ChatPage } from "./pages/ChatPage.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { McpServerFormPage } from "./pages/McpServerFormPage.jsx";
import { McpServersPage } from "./pages/McpServersPage.jsx";
import { ModelProviderFormPage } from "./pages/ModelProviderFormPage.jsx";
import { ModelProvidersPage } from "./pages/ModelProvidersPage.jsx";
import { RunDetailPage } from "./pages/RunDetailPage.jsx";
import { RunsPage } from "./pages/RunsPage.jsx";
import { SkillFormPage } from "./pages/SkillFormPage.jsx";
import { SkillsPage } from "./pages/SkillsPage.jsx";
import { TemplateFormPage } from "./pages/TemplateFormPage.jsx";
import { TemplatesPage } from "./pages/TemplatesPage.jsx";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:agentId" element={<ChatPage />} />

        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/new" element={<AgentFormPage mode="create" />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route
          path="/agents/:id/edit"
          element={<AgentFormPage mode="edit" />}
        />

        <Route path="/model-providers" element={<ModelProvidersPage />} />
        <Route
          path="/model-providers/new"
          element={<ModelProviderFormPage mode="create" />}
        />
        <Route
          path="/model-providers/:id/edit"
          element={<ModelProviderFormPage mode="edit" />}
        />

        <Route path="/mcp-servers" element={<McpServersPage />} />
        <Route
          path="/mcp-servers/new"
          element={<McpServerFormPage mode="create" />}
        />
        <Route
          path="/mcp-servers/:id/edit"
          element={<McpServerFormPage mode="edit" />}
        />

        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/skills/new" element={<SkillFormPage mode="create" />} />
        <Route
          path="/skills/:id/edit"
          element={<SkillFormPage mode="edit" />}
        />

        <Route path="/templates" element={<TemplatesPage />} />
        <Route
          path="/templates/new"
          element={<TemplateFormPage mode="create" />}
        />
        <Route
          path="/templates/:id/edit"
          element={<TemplateFormPage mode="edit" />}
        />

        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <EmptyState
      icon="search"
      title="No such page"
      description="The address does not match any screen in this console."
      action={
        <Button asChild>
          <Link to="/">Back to dashboard</Link>
        </Button>
      }
    />
  );
}
