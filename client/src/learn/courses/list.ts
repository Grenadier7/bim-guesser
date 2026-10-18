// Kursliste in Lernpfad-Reihenfolge – ohne Karte/Ansicht, damit Tests die Kurse auch ohne Browser bauen können
import { busCourse } from './bus.ts';
import { danubeCourse } from './danube.ts';
import { nightCourse } from './night.ts';
import { radialCourse } from './radial.ts';
import { ringCourse } from './ring.ts';
import { sbahnCourse } from './sbahn.ts';
import { southCourse } from './south.ts';
import { tangentialCourse } from './tangential.ts';
import { ubahnCourse } from './ubahn.ts';
import type { Course } from './common.ts';

/** Reihenfolge = Lernpfad: erst das Schnellbahn-Gerüst, dann die Muster der Bim, zuletzt Busse und Nacht */
export const COURSES: Course[] = [ubahnCourse, sbahnCourse, radialCourse, ringCourse, tangentialCourse, danubeCourse, southCourse, busCourse, nightCourse];
