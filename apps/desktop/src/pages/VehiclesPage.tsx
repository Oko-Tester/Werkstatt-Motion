import { HiddenPanel } from "../components/HiddenPanel";
import { PaymentsPanel } from "../components/PaymentsPanel";
import { PrimaryButton } from "../components/PrimaryButton";
import { SearchInput } from "../components/SearchInput";
import { VehicleTable } from "../components/VehicleTable";
import { HeaderActions, HeaderStart } from "../state/headerSlots";
import { useAreaSearchRef } from "../state/searchFocus";
import { useWorkshop } from "../state/WorkshopProvider";

/**
 * Fahrzeugliste mit den offenen Zahlungen darunter. In der Kopfzeile stehen die
 * Suche und „+ Fahrzeug“. Nach dem Long-Press am Logo kommt der versteckte
 * Bereich neben die Zahlungen.
 */
export function VehiclesPage() {
  const { vehicles, payments, secret, draftSupport, customerSuggestions, loading, loadError, reload } =
    useWorkshop();
  const { autoFocusId, fieldErrors } = draftSupport;
  const searchRef = useAreaSearchRef();

  return (
    <>
      <HeaderStart>
        <div className="header-search">
          <SearchInput value={vehicles.search} onChange={vehicles.setSearch} inputRef={searchRef} />
        </div>
      </HeaderStart>
      <HeaderActions>
        <PrimaryButton onClick={vehicles.add}>+ Fahrzeug</PrimaryButton>
      </HeaderActions>
      <section className="vehicle-section" aria-label="Fahrzeuge">
        <VehicleTable
          vehicles={vehicles.visibleVehicles}
          drafts={vehicles.drafts}
          columnOrder={vehicles.columnOrder}
          hiddenColumns={vehicles.hiddenColumns}
          loading={loading}
          loadError={loadError}
          onRetryLoad={() => void reload()}
          onAdd={vehicles.add}
          autoFocusId={autoFocusId}
          fieldErrors={fieldErrors}
          onCommitText={vehicles.commitText}
          onAppointmentChange={vehicles.changeAppointment}
          onToggleStatus={vehicles.toggleStatus}
          onArchive={vehicles.archive}
          onDraftRowLeave={vehicles.onDraftRowLeave}
          onMove={vehicles.move}
          onColumnOrderChange={vehicles.changeColumnOrder}
          onHiddenColumnsChange={vehicles.changeHiddenColumns}
        />
      </section>
      <div className={secret.isOpen ? "bottom-area is-split" : "bottom-area"}>
        <PaymentsPanel
          payments={payments.list}
          drafts={payments.drafts}
          suggestions={customerSuggestions}
          collapsed={payments.collapsed}
          height={payments.height}
          autoFocusId={autoFocusId}
          fieldErrors={fieldErrors}
          onToggleCollapsed={payments.toggleCollapsed}
          onHeightChange={payments.setHeight}
          onHeightCommit={payments.persistHeight}
          onAdd={payments.add}
          onCommitText={payments.commitText}
          onSelectVehicle={payments.selectVehicle}
          onCommitAmount={payments.commitAmount}
          onMarkPaid={payments.markPaid}
          onDraftRowLeave={payments.onDraftRowLeave}
        />
        {secret.isOpen && (
          <HiddenPanel
            status={secret.status}
            entries={secret.entries}
            drafts={secret.drafts}
            suggestions={customerSuggestions}
            autoFocusId={autoFocusId}
            fieldErrors={fieldErrors}
            onAdd={secret.add}
            onCommitText={secret.commitText}
            onCommitAmount={secret.commitAmount}
            onArchive={secret.archive}
            onDraftRowLeave={secret.onDraftRowLeave}
            onClose={secret.close}
          />
        )}
      </div>
    </>
  );
}
