"""
Phase 0 of docs/sap-desktop-agent-plan.md §4.7 — and nothing more than that.

This answers exactly one question: does SAP GUI Scripting give clean,
reliable, structured access to a table screen on this SAP system. It does not
connect to a relay, does not run unattended, and is not the shape the eventual
local companion agent will take — it is a throwaway script to run once, by
hand, and read the output of.

REQUIREMENTS, all on the Windows machine this runs on:
  - SAP GUI for Windows installed, with a session already logged in (this
    script attaches to that session — see §4.3 of the plan doc on why: no SAP
    credential should be handled by this script or anything downstream of it).
  - SAP GUI Scripting enabled, both:
      - server-side: profile parameter sapgui/user_scripting = TRUE
        (the customer's Basis team sets this — see plan doc §4.6, the one
        non-engineering blocker)
      - client-side: SAP GUI Options > Accessibility & Scripting > Scripting,
        "Enable scripting" checked
  - Python for Windows with pywin32: `pip install pywin32`

USAGE:
    python read_table.py [TCODE] [TABLE_NAME]
    python read_table.py            # defaults to SE16N / MARA

WHAT THIS HAS NOT BEEN VERIFIED AGAINST:
  This script was written without access to a Windows machine, SAP GUI, or any
  SAP system to run it against. The SAP GUI Scripting object model used below
  (Session, findById, the SAPGUI wnd[0]/tbar[0]/okcd path, the grid control's
  ColumnOrder/GetCellValue interface) matches SAP's own published Scripting API
  documentation, but the exact widget tree on a real SE16N result screen can
  vary by SAP version, screen variant, and customer configuration. Treat a
  first run as debugging the actual widget tree on your system, not as a
  finished tool — the diagnostic dump at the bottom prints the child ids under
  wnd[0] specifically so a failed `findById` call has something to work from.
"""

import sys

try:
    import win32com.client
except ImportError:
    print("pywin32 is required: pip install pywin32", file=sys.stderr)
    sys.exit(1)


def get_running_sap_session():
    """
    Attaches to an already-running, already-logged-in SAP GUI session — see
    plan doc §4.3: this script never logs in and never handles a credential.
    """
    sap_gui_auto = win32com.client.GetObject("SAPGUI")
    application = sap_gui_auto.GetScriptingEngine
    if application.Children.Count == 0:
        raise RuntimeError(
            "No open SAP GUI connection found. Open SAP Logon, log into a system by "
            "hand, and leave that session open before running this script."
        )
    connection = application.Children(0)
    if connection.Children.Count == 0:
        raise RuntimeError("SAP GUI connection has no open session.")
    return connection.Children(0)


def enter_tcode(session, tcode):
    """Types into the OK-code field the way a person does, then presses Enter."""
    session.findById("wnd[0]/tbar[0]/okcd").text = "/n" + tcode
    session.findById("wnd[0]").sendVKey(0)  # Enter


def read_se16n_table(session, table_name, max_rows=50):
    """
    Drives SE16N specifically: enter the table name, execute (F8), and read the
    result grid. SE16N's own screen layout is what this targets — a different
    tcode needs a different sequence of field ids past this point, which is
    exactly the kind of thing this Phase 0 script exists to nail down for your
    actual SAP version before anything gets built on top of an assumption.
    """
    session.findById("wnd[0]/usr/ctxtI2-DATABASE").text = table_name
    session.findById("wnd[0]").sendVKey(8)  # Execute (F8)

    # SE16N's result screen puts the grid at this id on most systems and
    # versions; if this raises, the diagnostic dump below is the next step —
    # inspect wnd[0]'s children on the actual result screen and adjust this id.
    grid = session.findById("wnd[0]/usr/cntlGRID1/shellcont/shell")

    column_count = grid.ColumnCount
    row_count = min(grid.RowCount, max_rows)
    columns = [grid.GetColumnTitle(index) for index in range(column_count)]

    rows = []
    for row in range(row_count):
        rows.append([grid.GetCellValue(row, columns[col]) for col in range(column_count)])

    return columns, rows


def dump_children(element, prefix="  "):
    """
    Diagnostic only: prints every child id under a screen element. Point this
    at wnd[0] on a screen where a `findById` call above failed, to find the
    real id to use instead.
    """
    try:
        children = element.Children
    except Exception:
        return
    for index in range(children.Count):
        child = children.Item(index)
        try:
            print(f"{prefix}{child.Id}  ({child.Type})")
        except Exception:
            print(f"{prefix}<unreadable child at index {index}>")
        dump_children(child, prefix + "  ")


def main():
    tcode = sys.argv[1] if len(sys.argv) > 1 else "SE16N"
    table_name = sys.argv[2] if len(sys.argv) > 2 else "MARA"

    print(f"Attaching to the open SAP GUI session...")
    session = get_running_sap_session()
    print(f"Attached. System: {session.Info.SystemName}, user: {session.Info.User}")

    print(f"Navigating to {tcode}...")
    enter_tcode(session, tcode)

    if tcode.upper() != "SE16N":
        print(
            f"{tcode} is not SE16N — read_se16n_table() only knows SE16N's screen "
            "layout. Navigation succeeded; add a reader for this tcode's screen "
            "the same way, or inspect it with dump_children(session.findById('wnd[0]'))."
        )
        return

    try:
        columns, rows = read_se16n_table(session, table_name)
    except Exception as error:
        print(f"Could not read the result grid: {error}")
        print("Dumping wnd[0]'s children for debugging:")
        dump_children(session.findById("wnd[0]"))
        raise

    print(f"\n{table_name}: {len(rows)} row(s) shown, columns: {columns}\n")
    for row in rows:
        print(row)


if __name__ == "__main__":
    main()
