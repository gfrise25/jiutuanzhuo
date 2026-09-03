import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "空白專案" },
      { name: "description", content: "空白專案" },
    ],
  }),
  component: Index,
});

function Index() {
  return <div className="min-h-screen bg-background" />;
}
