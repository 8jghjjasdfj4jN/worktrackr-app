// web/client/src/app/src/components/Dashboard.jsx
// REDESIGN Push 2: Removed duplicate inner header (now in AppLayout TopBar).
// Replaced coloured badge pills with compact tab chips.
// Compact inline stats row replaces nothing (was never big cards — those were in spec for future).
// All logic, state, modals, and child components completely unchanged.
// Session 26: Jobs → Projects rename pass — no visible "Job/Jobs" text in this file;
//   internal view identifier 'jobs' intentionally unchanged.

import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useAuth } from '../../../context/AuthProvider.jsx';
import { useSimulation } from '../App.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Badge } from '@/components/ui/badge.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.jsx';
import {
  Plus, Search, Users, Ticket, Clock, CheckCircle, AlertCircle,
  X, User, Mail, Settings, Workflow, Bell, RefreshCw, Calendar,
  Trash2, UserPlus, Flag, GitMerge, ChevronDown, Package, LogOut,
  Building2, DollarSign
} from 'lucide-react';
import PageHero, { HeroButtonPrimary } from './PageHero.jsx';

import TicketCard from './TicketCard.jsx';
import TicketDetailModal from './TicketDetailModal.jsx';
import CreateTicketModal from './CreateTicketModal.jsx';
import AssignTicketsModal from './AssignTicketsModal.jsx';
import EmailLogModal from './EmailLogModal.jsx';
import TicketFieldCustomizer from './TicketFieldCustomizer.jsx';
import UserManagementImproved from './UserManagementImproved.jsx';
import PlanManagement from './PlanManagement.jsx';
import IntegratedCalendar from './IntegratedCalendar.jsx';
import XeroIntegration from './XeroIntegration.jsx';
import CRMDashboard from './CRMDashboard.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import CRMCalendar from './CRMCalendar.jsx';
import ContactManager from './ContactManager.jsx';
import CompanyPipelineList from './CompanyPipelineList.jsx';
import CompanyProfile from './CompanyProfile.jsx';
import AddCompanyPage from './AddCompanyPage.jsx';
import MyTasks from './MyTasks.jsx';
import OrdersList from './OrdersList.jsx';
import ContractsList from './ContractsList.jsx';
import LeadsList from './LeadsList.jsx';
import SalesQuotes from './SalesQuotes.jsx';
import SalesTabs from './SalesTabs.jsx';
import useSalesPermissions from '../hooks/useSalesPermissions.js';
import MyPay from './MyPay.jsx';
import MyHoliday from './MyHoliday.jsx';
import HolidayManager from './HolidayManager.jsx';
import OrderQueues from './OrderQueues.jsx';
import BonusScreen from './BonusScreen.jsx';
import CommissionRules from './CommissionRules.jsx';
import EngineerWage from './EngineerWage.jsx';
import EngineerWageAdmin from './EngineerWageAdmin.jsx';
import SecuritySettings from './SecuritySettings.jsx';
import EmailIntakeSettings from './EmailIntakeSettings.jsx';
import TicketsTableView from './TicketsTableView.jsx';
import TicketDetailView from './TicketDetailViewTabbed.jsx';
import PersonalNotes from './PersonalNotes.jsx';
import CompanyNotes from './CompanyNotes.jsx';
import JobsList from './JobsList.jsx';
import InvoicesList from './InvoicesList.jsx';

// ─── Status chip style (dark) ─────────────────────────────────────────────────
const chipBase = 'text-[12px] font-medium px-3 py-1.5 rounded-md border transition-colors cursor-pointer whitespace-nowrap';
const chipActive = 'bg-[rgba(245,158,11,0.15)] text-[#fcd34d] border-[#f59e0b]';
const chipInactive = 'text-[#94a3b8] border-transparent hover:bg-[#242438] hover:text-white';

// ─── Stat card (dark) ─────────────────────────────────────────────────────────
const StatCard = ({ label, count, iconBg, iconColor, Icon, onClick, active }) => (
  <div
    onClick={onClick}
    className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border cursor-pointer
                transition-all flex-1 min-w-[120px] bg-[#242438]
                ${active ? 'border-[#f59e0b]' : 'border-[#2e2e4a] hover:border-[#f59e0b]'}`}
  >
    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
      <Icon className={`w-[16px] h-[16px] ${iconColor}`} />
    </div>
    <div>
      <div className="text-[20px] font-bold text-white leading-none">{count}</div>
      <div className="text-[11px] font-medium text-[#94a3b8] mt-0.5">{label}</div>
    </div>
  </div>
);

// ─── Dashboard ────────────────────────────────────────────────────────────────
// Engineers get a delivery-only app: they may only reach these views. Everything
// else (Sales/Finance/Settings — anything that can show company/order/contract/
// quote/invoice profit) is bounced to Tickets. Deny-by-default keeps the rule safe
// if new views are added later.
const ENGINEER_ALLOWED_VIEWS = ['tickets', 'jobs', 'calendar', 'my-tasks', 'my-pay', 'my-wage', 'my-notes', 'my-holiday'];

const Dashboard = forwardRef(({ currentView, onViewChange, onFullBleedChange }, ref) => {
  const { user, membership, logout } = useAuth();
  const { tickets, users, emailLogs, bulkUpdateTickets, bulkDeleteTickets } = useSimulation();

  const [activeTab, setActiveTab]             = useState('all_open');
  const [openCompanyId, setOpenCompanyId]     = useState(null);
  // Which screen a company record was opened FROM. Set when the Calendar opens
  // a company so its Back link returns to the Calendar rather than dumping the
  // user on the Companies list, which is where they'd have to start again.
  // null = opened from the Companies list, so Back behaves exactly as before.
  const [companyOpenedFrom, setCompanyOpenedFrom] = useState(null);
  const openCompanyFrom = (fromView) => (id) => {
    if (!id) return;
    setCompanyOpenedFrom(fromView);
    setOpenCompanyId(id);
    onViewChange('companies');
  };
  const backFromCompany = () => {
    setOpenCompanyId(null);
    if (companyOpenedFrom) { const to = companyOpenedFrom; setCompanyOpenedFrom(null); onViewChange(to); }
  };
  const [calendarInitial, setCalendarInitial] = useState(null); // 'YYYY-MM-DD' for "View in calendar"
  const [addingCompany, setAddingCompany]     = useState(false);
  const [openLeadCompanyId, setOpenLeadCompanyId] = useState(null);
  const [ordersInitial, setOrdersInitial]     = useState(null);
  const [ordersOpenId, setOrdersOpenId]       = useState(null);
  const { can: salesCan } = useSalesPermissions();
  const SALES_VIEW_PERM = { companies: 'companies', quotes: 'quotes', orders: 'orders', 'sales-calendar': 'calendar' };
  const [contractsInitial, setContractsInitial] = useState(null);
  const [searchTerm, setSearchTerm]           = useState('');
  const [priorityFilter, setPriorityFilter]   = useState('all');
  const [assigneeFilter, setAssigneeFilter]   = useState('all');
  const [selectedTicket, setSelectedTicket]   = useState(null);
  const [viewingTicketId, setViewingTicketId] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEmailModal, setShowEmailModal]   = useState(false);
  const [showTicketCustomizer, setShowTicketCustomizer] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedTickets, setSelectedTickets] = useState(new Set());
  const [loading, setLoading]                 = useState(false);
  const [selectedTimezone, setSelectedTimezone] = useState(
    () => localStorage.getItem('worktrackr-timezone') || 'Europe/London'
  );
  const [ticketViewMode] = useState(
    () => localStorage.getItem('worktrackr-ticket-view-mode') || 'table'
  );

  useImperativeHandle(ref, () => ({
    clearViewingTicket: () => setViewingTicketId(null)
  }));

  // Engineer route guard: if an engineer somehow lands on a non-allowed view
  // (deep-link, click-through, role resolving after navigation), send them to
  // Tickets. The render below also refuses to draw blocked content.
  useEffect(() => {
    if (membership?.role === 'engineer' && !ENGINEER_ALLOWED_VIEWS.includes(currentView)) {
      onViewChange('tickets');
    }
  }, [membership, currentView]);

  // Tell the layout when a dark, full-bleed redesigned page is showing, so it
  // drops the light padded wrapper (removes the white gutter). Extend the
  // condition here as more dark/full-screen pages land.
  useEffect(() => {
    // The redesigned dark Sales pages (Companies list/profile/add, Quotes, Orders)
    // go edge-to-edge, plus the dark Workspace screens (My Tasks, Approvals,
    // My Pay). The Calendar tab, My Notes, Leads/Contracts are still light.
    const fb = ['companies', 'quotes', 'orders', 'my-tasks', 'order-queues', 'my-pay', 'my-holiday', 'holiday-admin', 'my-notes', 'jobs', 'calendar', 'sales-calendar', 'crm-calendar'].includes(currentView);
    if (onFullBleedChange) onFullBleedChange(fb);
  }, [currentView, openCompanyId, addingCompany, onFullBleedChange]);

  // Loading guard
  if (user === undefined || membership === undefined) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#d4a017] mx-auto" />
          <p className="mt-2 text-[#9ca3af] text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  const isAdmin = membership?.role === 'admin' || membership?.role === 'owner';
  const isManager = ['admin', 'manager', 'owner', 'partner_admin'].includes(membership?.role);
  const isEngineer = membership?.role === 'engineer';

  // ── Ticket counts ──────────────────────────────────────────────────────────
  const ticketCounts = {
    all:        tickets.length,
    open:       tickets.filter(t => t.status === 'open').length,
    in_progress:tickets.filter(t => t.status === 'in_progress').length,
    pending:    tickets.filter(t => t.status === 'pending').length,
    closed:     tickets.filter(t => t.status === 'closed').length,
    resolved:   tickets.filter(t => t.status === 'resolved').length,
    all_open:   tickets.filter(t => ['open','in_progress','pending'].includes(t.status)).length,
    my_tickets: tickets.filter(t => t.assignedTo === user?.id).length,
  };

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filteredTickets = tickets.filter(ticket => {
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return (
        ticket.title?.toLowerCase().includes(q) ||
        ticket.description?.toLowerCase().includes(q) ||
        ticket.contactDetails?.contact_name?.toLowerCase().includes(q) ||
        ticket.contactDetails?.company_name?.toLowerCase().includes(q)
      );
    }
    if (activeTab === 'open'        && ticket.status !== 'open')        return false;
    if (activeTab === 'in_progress' && ticket.status !== 'in_progress') return false;
    if (activeTab === 'pending'     && ticket.status !== 'pending')     return false;
    if (activeTab === 'closed'      && ticket.status !== 'closed')      return false;
    if (activeTab === 'resolved'    && ticket.status !== 'resolved')    return false;
    if (activeTab === 'all_open'    && !['open','in_progress','pending'].includes(ticket.status)) return false;
    if (activeTab === 'my_tickets'  && ticket.assignedTo !== user?.id)  return false;
    if (priorityFilter !== 'all'    && ticket.priority !== priorityFilter) return false;
    if (assigneeFilter !== 'all'    && ticket.assignedTo !== assigneeFilter) return false;
    return true;
  });

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selectedTickets.size} ticket(s)? This cannot be undone.`)) return;
    setLoading(true);
    try {
      await bulkDeleteTickets(Array.from(selectedTickets));
      setSelectedTickets(new Set());
    } catch (e) { alert('Failed to delete tickets.'); }
    finally { setLoading(false); }
  };

  const handleAssignConfirm = async (userId) => {
    setLoading(true);
    try {
      await bulkUpdateTickets(Array.from(selectedTickets), { assigneeId: userId });
      setSelectedTickets(new Set());
      setShowAssignModal(false);
    } catch (e) { alert(`Failed to assign: ${e.message}`); }
    finally { setLoading(false); }
  };

  const handleBulkSetStatus = async (status) => {
    setLoading(true);
    try { await bulkUpdateTickets(Array.from(selectedTickets), { status }); setSelectedTickets(new Set()); }
    catch (e) { alert('Failed to update status.'); }
    finally { setLoading(false); }
  };

  const handleBulkSetPriority = async (priority) => {
    setLoading(true);
    try { await bulkUpdateTickets(Array.from(selectedTickets), { priority }); setSelectedTickets(new Set()); }
    catch (e) { alert('Failed to update priority.'); }
    finally { setLoading(false); }
  };

  const handleMergeTickets = () => {
    if (selectedTickets.size < 2) { alert('Select at least 2 tickets to merge'); return; }
    alert('Merge functionality coming soon!');
  };

  const setTab = (tab) => { setActiveTab(tab); setSearchTerm(''); setViewingTicketId(null); };

  // ── Tickets view — rendered as inline JSX, NOT as a sub-component, to prevent
  // focus loss on search input. Defining `const TicketsView = () => ...` inside
  // the render function creates a new component type every render, causing React
  // to unmount/remount the entire subtree and losing input focus on every keystroke.
  const ticketsViewJSX = (
    <div className="p-5 md:p-7 min-h-full bg-[#1a1a2e]">
      {/* Hero header */}
      <div className="mb-5">
        <PageHero
          title="Tickets"
          icon={Ticket}
          meta={[{ label: `${ticketCounts.all_open} open` }]}
          actions={
            <HeroButtonPrimary icon={Plus} onClick={() => setShowCreateModal(true)}>New ticket</HeroButtonPrimary>
          }
          compact
        />
      </div>

      {/* ── Inline stat cards ── */}
      <div className="flex flex-wrap gap-3 mb-5">
        <StatCard label="All open"   count={ticketCounts.all_open}   Icon={Ticket}       iconBg="bg-[rgba(107,114,128,0.20)]"  iconColor="text-[#cbd5e1]" onClick={() => setTab('all_open')}   active={activeTab==='all_open'} />
        <StatCard label="Open"       count={ticketCounts.open}       Icon={CheckCircle}  iconBg="bg-[rgba(16,185,129,0.20)]"  iconColor="text-[#6ee7b7]" onClick={() => setTab('open')}       active={activeTab==='open'} />
        <StatCard label="In progress"count={ticketCounts.in_progress}Icon={Clock}        iconBg="bg-[rgba(59,130,246,0.20)]"  iconColor="text-[#93c5fd]" onClick={() => setTab('in_progress')} active={activeTab==='in_progress'} />
        <StatCard label="Pending"    count={ticketCounts.pending}    Icon={AlertCircle}  iconBg="bg-[rgba(245,158,11,0.20)]"  iconColor="text-[#fcd34d]" onClick={() => setTab('pending')}    active={activeTab==='pending'} />
        <StatCard label="Resolved"   count={ticketCounts.resolved}   Icon={CheckCircle}  iconBg="bg-[rgba(59,130,246,0.20)]"  iconColor="text-[#93c5fd]" onClick={() => setTab('resolved')}   active={activeTab==='resolved'} />
        <StatCard label="Closed"     count={ticketCounts.closed}     Icon={X}            iconBg="bg-[rgba(107,114,128,0.20)]"  iconColor="text-[#cbd5e1]" onClick={() => setTab('closed')}     active={activeTab==='closed'} />
      </div>

      {/* ── Table container ── */}
      <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] overflow-hidden">

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-5 py-3.5 border-b border-[#2e2e4a]">
          {/* Tab pills */}
          {[
            { key: 'all_open',    label: 'All open',    count: ticketCounts.all_open },
            { key: 'my_tickets',  label: 'My tickets',  count: ticketCounts.my_tickets },
            { key: 'in_progress', label: 'In progress', count: ticketCounts.in_progress },
            { key: 'pending',     label: 'Pending',     count: ticketCounts.pending },
            { key: 'resolved',    label: 'Resolved',    count: ticketCounts.resolved },
            { key: 'closed',      label: 'Closed',      count: ticketCounts.closed },
            { key: 'all',         label: 'All',         count: ticketCounts.all },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setTab(tab.key)}
              className={`${chipBase} ${activeTab === tab.key ? chipActive : chipInactive}`}
            >
              {tab.label}
              <span className={`ml-1 text-[10px] ${activeTab === tab.key ? 'text-[#d4a017] font-bold' : 'text-[#9ca3af]'}`}>
                {tab.count}
              </span>
            </button>
          ))}

          {/* Right tools */}
          <div className="ml-auto flex items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#6b7280]" />
              <input
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search tickets..."
                className="pl-8 pr-3 py-1.5 text-[12px] border border-[#2e2e4a] rounded-md bg-[#1a1a2e]
                           text-white placeholder:text-[#6b7280] focus:outline-none
                           focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b] w-[180px]"
              />
            </div>

            {isAdmin && (
              <button
                onClick={() => setShowTicketCustomizer(true)}
                className="text-[12px] text-[#94a3b8] border border-[#2e2e4a] bg-[#242438] px-3 py-1.5
                           rounded-md flex items-center gap-1 hover:bg-[#2a2a48] transition-colors"
              >
                <Workflow className="w-3.5 h-3.5" /> Customize
              </button>
            )}
          </div>
        </div>

        {/* Bulk action bar — only shown when rows selected */}
        {selectedTickets.size > 0 && (
          <div className="flex items-center gap-2 px-5 py-2 bg-[rgba(245,158,11,0.08)] border-b border-[#2e2e4a]">
            <span className="text-[12px] font-medium text-[#fcd34d]">{selectedTickets.size} selected</span>
            <div className="flex items-center gap-1 ml-2">
              <button onClick={handleBulkDelete} disabled={loading}
                className="text-[12px] text-[#94a3b8] hover:text-[#fca5a5] px-2 py-1 rounded flex items-center gap-1">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
              <button onClick={() => setShowAssignModal(true)} disabled={loading}
                className="text-[12px] text-[#94a3b8] hover:text-white px-2 py-1 rounded flex items-center gap-1">
                <UserPlus className="w-3.5 h-3.5" /> Assign
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button disabled={loading}
                    className="text-[12px] text-[#94a3b8] hover:text-white px-2 py-1 rounded flex items-center gap-1">
                    <Settings className="w-3.5 h-3.5" /> Status <ChevronDown className="w-3 h-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {['open','in_progress','pending','resolved','closed'].map(s => (
                    <DropdownMenuItem key={s} onClick={() => handleBulkSetStatus(s)}>
                      {s.replace('_',' ').replace(/\b\w/g, c => c.toUpperCase())}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button disabled={loading}
                    className="text-[12px] text-[#94a3b8] hover:text-white px-2 py-1 rounded flex items-center gap-1">
                    <Flag className="w-3.5 h-3.5" /> Priority <ChevronDown className="w-3 h-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {[{value:'low',label:'Low'},{value:'medium',label:'Medium'},{value:'high',label:'High'},{value:'urgent',label:'Urgent'}].map((p) => (
                    <DropdownMenuItem key={p.value} onClick={() => handleBulkSetPriority(p.value)}>
                      {p.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button onClick={handleMergeTickets} disabled={selectedTickets.size < 2 || loading}
                className="text-[12px] text-[#94a3b8] hover:text-white px-2 py-1 rounded flex items-center gap-1">
                <GitMerge className="w-3.5 h-3.5" /> Merge
              </button>
            </div>
            <button onClick={() => setSelectedTickets(new Set())}
              className="ml-auto text-[#9ca3af] hover:text-[#6b7280]">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Tickets table or detail view */}
        {viewingTicketId ? (
          <div className="p-6">
            <TicketDetailView
              ticketId={viewingTicketId}
              onBack={() => { setViewingTicketId(null); setActiveTab('all_open'); }}
            />
          </div>
        ) : (
          <TicketsTableView
            tickets={filteredTickets}
            users={users}
            selectedTickets={selectedTickets}
            setSelectedTickets={setSelectedTickets}
            onTicketClick={(ticket) => setViewingTicketId(ticket.id)}
          />
        )}
      </div>

      {showAssignModal && (
        <AssignTicketsModal
          users={users}
          ticketIds={Array.from(selectedTickets)}
          onAssign={handleAssignConfirm}
          onClose={() => setShowAssignModal(false)}
        />
      )}
    </div>
  );

  // ── Render by view ─────────────────────────────────────────────────────────
  const SALES_VIEWS = ['companies', 'leads', 'quotes', 'orders', 'contracts', 'sales-calendar'];

  // Hard stop: never render a profit-bearing/blocked screen for an engineer (the
  // effect above is already redirecting them to Tickets).
  if (isEngineer && !ENGINEER_ALLOWED_VIEWS.includes(currentView)) {
    return (
      <div className="p-6 text-[13px] text-gray-500">This area isn't available for your role. Taking you to Tickets…</div>
    );
  }

  const salesProfileOpen =
    (currentView === 'companies' && (openCompanyId || addingCompany)) ||
    (currentView === 'leads' && openLeadCompanyId);
  return (
    <div className="space-y-0">
      {SALES_VIEWS.includes(currentView) && !salesProfileOpen && (
        <SalesTabs current={currentView} onChange={onViewChange} dark={['companies', 'quotes', 'orders', 'sales-calendar'].includes(currentView)} />
      )}
      {currentView === 'tickets'        && <>{ticketsViewJSX}</>}
      {currentView === 'users' && isAdmin && <UserManagementImproved users={users} currentUser={user} />}
      {currentView === 'calendar'       && (
        <CRMCalendar
          timezone={selectedTimezone}
          calendarKind="delivery"
          defaultSources={{ sales: false, projects: true, schedule: true }}
          onOpenCompany={salesCan('companies') ? openCompanyFrom('calendar') : undefined}
          onTicketClick={(ticket) => { setViewingTicketId(ticket.id); onViewChange('tickets'); }}
        />
      )}
      {currentView === 'sales-calendar' && salesCan('calendar') && (
        <CRMCalendar
          key={calendarInitial || 'today'}
          initialDate={calendarInitial}
          timezone={selectedTimezone}
          calendarKind="sales"
          defaultSources={{ sales: true, projects: false, schedule: false }}
          onOpenCompany={salesCan('companies') ? openCompanyFrom('sales-calendar') : undefined}
          onTicketClick={(ticket) => { setViewingTicketId(ticket.id); onViewChange('tickets'); }}
        />
      )}
      {currentView === 'billing' && isAdmin && <XeroIntegration />}
      {currentView === 'contacts'       && <ContactManager />}
      {currentView === 'companies'      && salesCan('companies') && (
        addingCompany
          ? <AddCompanyPage
              onCancel={() => setAddingCompany(false)}
              onCreated={(id) => { setAddingCompany(false); if (id) setOpenCompanyId(id); }} />
          : openCompanyId
            ? <CompanyProfile companyId={openCompanyId} onBack={backFromCompany}
                onNewOrder={(company) => { setOrdersInitial(company.id); onViewChange('orders'); }}
                onOpenCalendar={(dayStr) => { setCalendarInitial(dayStr); onViewChange('sales-calendar'); }}
                onNewContract={(company) => { setContractsInitial(company.id); onViewChange('contracts'); }} />
            : <CompanyPipelineList onOpenCompany={setOpenCompanyId} onAddCompany={() => setAddingCompany(true)} isManager={isManager} currentUser={user} />
      )}
      {currentView === 'orders'         && salesCan('orders') && <OrdersList isManager={isManager} initialNewCompanyId={ordersInitial} onConsumeInitial={() => setOrdersInitial(null)} initialOpenOrderId={ordersOpenId} onConsumeOpen={() => setOrdersOpenId(null)} />}
      {currentView === 'contracts'      && <ContractsList initialNewCompanyId={contractsInitial} onConsumeInitial={() => setContractsInitial(null)} isManager={isManager} />}
      {currentView === 'leads'          && (
        openLeadCompanyId
          ? <CompanyProfile companyId={openLeadCompanyId} onBack={() => setOpenLeadCompanyId(null)}
              onNewOrder={(company) => { setOrdersInitial(company.id); onViewChange('orders'); }}
              onNewContract={(company) => { setContractsInitial(company.id); onViewChange('contracts'); }} />
          : <LeadsList onOpenCompany={setOpenLeadCompanyId} currentUser={user} isManager={isManager} />)}
      {currentView === 'order-queues'   && <OrderQueues />}
      {currentView === 'my-commission'  && <BonusScreen />}
      {currentView === 'my-pay'         && <MyPay />}
      {currentView === 'my-holiday'     && <MyHoliday />}
      {currentView === 'holiday-admin'  && (isManager ? <HolidayManager /> : <MyHoliday />)}
      {currentView === 'commission-rules' && <CommissionRules />}
      {currentView === 'my-wage'        && <EngineerWage />}
      {currentView === 'engineer-wages' && <EngineerWageAdmin />}
      {currentView === 'my-tasks'       && <MyTasks />}
      {currentView === 'crm'            && <ErrorBoundary><CRMDashboard timezone={selectedTimezone} /></ErrorBoundary>}
      {currentView === 'product-catalog'&& <ErrorBoundary><CRMDashboard timezone={selectedTimezone} defaultTab="catalog" singleSection /></ErrorBoundary>}
      {currentView === 'quotes'         && salesCan('quotes') && <ErrorBoundary><SalesQuotes onOrderCreated={(orderId) => { setOrdersOpenId(orderId); onViewChange('orders'); }} /></ErrorBoundary>}
      {['companies', 'quotes', 'orders', 'sales-calendar'].includes(currentView) && !salesCan(SALES_VIEW_PERM[currentView]) && (
        <div className="p-10 text-center text-[13px] text-[#94a3b8] bg-[#1a1a2e] min-h-full">You don’t have access to this area. Ask an admin if you need it.</div>
      )}
      {currentView === 'crm-settings'   && <ErrorBoundary><CRMDashboard timezone={selectedTimezone} defaultTab="settings" singleSection /></ErrorBoundary>}
      {currentView === 'crm-calendar'   && <CRMCalendar timezone={selectedTimezone} onOpenCompany={salesCan('companies') ? openCompanyFrom('crm-calendar') : undefined} />}
      {currentView === 'security'       && <SecuritySettings />}
      {currentView === 'email-intake'   && <EmailIntakeSettings />}
      {currentView === 'my-notes'       && <PersonalNotes />}
      {currentView === 'company-notes'  && <CompanyNotes />}
      {currentView === 'jobs'           && <JobsList />}
      {currentView === 'invoices'       && <InvoicesList />}
      {currentView === 'pricing-config' && isAdmin && (
        <ErrorBoundary>
          <div className="p-5 md:p-7 min-h-full bg-[#1a1a2e]">
            <div className="mb-5">
              <PageHero
                title="Pricing & plan"
                icon={DollarSign}
                meta={[{ label: 'Your plan, seats, payment and account' }]}
                compact
              />
            </div>
            <PlanManagement totalUsers={users.length} />
          </div>
        </ErrorBoundary>
      )}

      {/* ── Modals ── */}
      {showCreateModal && (
        <CreateTicketModal onClose={() => setShowCreateModal(false)} users={users} currentUser={user} />
      )}
      {selectedTicket && (
        <TicketDetailModal ticketId={selectedTicket.id} onClose={() => setSelectedTicket(null)} />
      )}
      {showEmailModal && (
        <EmailLogModal emailLogs={emailLogs} onClose={() => setShowEmailModal(false)} />
      )}
      <TicketFieldCustomizer isOpen={showTicketCustomizer} onClose={() => setShowTicketCustomizer(false)} />
    </div>
  );
});

export default Dashboard;
