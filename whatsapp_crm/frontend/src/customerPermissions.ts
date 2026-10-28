export type CustomerAssignment = { assigneeUserId?: string | null };
type Access = { role: string; userId?: string | null; can: (capability: string) => boolean };

export function canOperateCustomer(access: Access, customer: CustomerAssignment | null | undefined, capability: string): boolean {
  if (!customer || !access.can(capability)) return false;
  if (access.role !== 'manager') return true;
  return Boolean(access.userId && customer.assigneeUserId === access.userId);
}

export function canOperateDeal(access: Access, deal: { clientChatId: string | null; createdBy?: string | null },
  customers: (CustomerAssignment & { chatId: string })[], capability: string): boolean {
  if (!access.can(capability)) return false;
  if (access.role !== 'manager') return true;
  if (deal.clientChatId) return canOperateCustomer(access, customers.find(customer => customer.chatId === deal.clientChatId), capability);
  return Boolean(access.userId && deal.createdBy === access.userId);
}
