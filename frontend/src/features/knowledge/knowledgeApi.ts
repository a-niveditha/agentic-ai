import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/apiClient";
import type { DocumentList, DocumentPayload } from "./knowledgeTypes";

export const documentKey = ["knowledge", "documents"] as const;

export type AddDocumentBody = FormData | { text: string; title: string } | { url: string };

export function getDocuments(): Promise<DocumentList> {
  return apiRequest("/documents");
}

export function addDocument(body: AddDocumentBody): Promise<DocumentPayload> {
  if (body instanceof FormData) return apiRequest("/documents", { method: "POST", body });
  return apiRequest("/documents", { method: "POST", body: JSON.stringify(body) });
}

export function retryDocument(id: string): Promise<DocumentPayload> {
  return apiRequest("/documents/" + id + "/retry", { method: "POST" });
}

export function deleteDocument(id: string): Promise<{ success: boolean }> {
  return apiRequest("/documents/" + id, { method: "DELETE" });
}

export function useDocuments() {
  return useQuery({
    queryKey: documentKey,
    queryFn: getDocuments,
    refetchInterval: (query) => query.state.data?.documents.some((doc) => doc.status === "processing") ? 2200 : false,
  });
}

export function useAddDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: addDocument,
    onSuccess: () => client.invalidateQueries({ queryKey: documentKey }),
  });
}

export function useRetryDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: retryDocument,
    onSuccess: () => client.invalidateQueries({ queryKey: documentKey }),
  });
}

export function useDeleteDocument() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteDocument,
    onSuccess: () => client.invalidateQueries({ queryKey: documentKey }),
  });
}
