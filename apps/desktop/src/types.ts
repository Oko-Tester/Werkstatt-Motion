export interface Vehicle {
  id: string;
  kunde: string;
  fahrzeug: string;
  kennzeichen: string;
  tuevNoetig: boolean;
  teileBestellt: boolean;
  teileAngekommen: boolean;
  fertig: boolean;
  archiviert: boolean;
}

export interface Payment {
  id: string;
  kunde: string;
  fahrzeug: string;
  betragCents: number;
  bezahlt: boolean;
}
