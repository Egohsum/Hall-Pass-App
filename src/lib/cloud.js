import { supabase, CLOUD_ENABLED, SCHOOL_ID } from "./supabaseClient";

/** Active passes (end_time is NULL) */
export async function cloudFetchActive() {
  if (!CLOUD_ENABLED) return { data: [], error: null };
  return await supabase
    .from("passes")
    .select("*")
    .eq("school_id", SCHOOL_ID)
    .is("end_time", null)
    .order("start_time", { ascending: false });
}

export async function cloudStartPass(pass) {
  if (!CLOUD_ENABLED) return { error: null };
  const row = {
    id: pass.id,
    student_id: pass.studentId || null,
    student_name: pass.student,
    destination: pass.destination,
    period: Number(pass.period) || null,
    start_time: new Date(pass.startTime).toISOString(),
    end_time: null,
    max_minutes: Number(pass.maxMinutes) || 0,
    over_limit: false,
    late_reason: "",
    school_id: SCHOOL_ID,
  };
  const { error } = await supabase.from("passes").insert(row);
  return { error };
}

export async function cloudEndPass(passId, ended) {
  if (!CLOUD_ENABLED) return { error: null };
  const { error } = await supabase
    .from("passes")
    .update({
      end_time: new Date(ended.endTime).toISOString(),
      over_limit: !!ended.overLimit,
      late_reason: ended.lateReason || "",
    })
    .eq("id", passId)
    .eq("school_id", SCHOOL_ID);
  return { error };
}

/** Roster helpers */
export async function cloudFetchRoster() {
  if (!CLOUD_ENABLED) return { data: [], error: null };
  return await supabase
    .from("students")
    .select("*")
    .eq("school_id", SCHOOL_ID);
}

export async function cloudUpsertStudent(studentId, name, period) {
  if (!CLOUD_ENABLED) return { error: null };
  const { error } = await supabase
    .from("students")
    .upsert(
      {
        student_id: String(studentId),
        name,
        period: Number(period) || null,
        school_id: SCHOOL_ID,
      },
      { onConflict: "student_id,school_id" }
    );
  return { error };
}

/** Realtime: call onChange() whenever passes table changes for this school */
export function cloudSubscribeActive(onChange) {
  if (!CLOUD_ENABLED) return () => {};
  const channel = supabase
    .channel("active-passes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "passes", filter: `school_id=eq.${SCHOOL_ID}` },
      () => onChange?.()
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
