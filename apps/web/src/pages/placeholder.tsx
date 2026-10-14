import { Page } from "@/app/shell"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** Shown for pages whose feature is not built yet. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <Page title={title}>
      <Card>
        <CardHeader>
          <CardTitle>Not built yet</CardTitle>
          <CardDescription>This page arrives with its feature.</CardDescription>
        </CardHeader>
      </Card>
    </Page>
  )
}
