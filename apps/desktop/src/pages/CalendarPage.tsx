import { CalendarWorkspace } from "../components/CalendarWorkspace";
import { useWorkshop } from "../state/WorkshopProvider";

/** Terminkalender: zeigt dieselben Fahrzeuge wie die Liste, ohne sie neu zu laden. */
export function CalendarPage() {
  const { vehicles } = useWorkshop();
  return <CalendarWorkspace vehicles={vehicles.list} />;
}
