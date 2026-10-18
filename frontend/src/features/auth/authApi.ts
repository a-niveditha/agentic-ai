import { apiRequest } from "@/lib/apiClient";

export type User = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
};

type AuthResponse = { user: User; token: string };

export function login(email: string, password: string): Promise<AuthResponse> {
  return apiRequest("/auth/login", {
    method: "POST",
    auth: false,
    body: JSON.stringify({ email, password }),
  });
}

export function signup(email: string, password: string, name: string): Promise<AuthResponse> {
  return apiRequest("/auth/signup", {
    method: "POST",
    auth: false,
    body: JSON.stringify({ email, password, name }),
  });
}

export async function getCurrentUser(): Promise<User> {
  const result = await apiRequest<{ user: User }>("/auth/me");
  return result.user;
}
