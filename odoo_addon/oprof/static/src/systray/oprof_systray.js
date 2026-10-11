import * as owlLib from "@odoo/owl";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { rpc } from "@web/core/network/rpc";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";

/**
 * oprof systray button: a switch that records every request of this user (one
 * recording session, grouped in VS Code) until it's switched off.
 * Its own calls go to /oprof/*, which are never marked.
 *
 * Written for Owl 2 (18.0 to saas~19.x) and Owl 3 (20.0) alike: static props on Owl 2 only
 * (Owl 3 rejects them), `this.` in the template, and the reactive state from `useState`
 * (Owl 2) or `proxy` (Owl 3).
 */
const { Component, onWillStart } = owlLib;
const reactiveState = owlLib.useState || owlLib.proxy;

export class OprofSystray extends Component {
    static template = "oprof.Systray";
    static components = { Dropdown, DropdownItem };

    setup() {
        this.action = useService("action");
        this.notification = useService("notification");
        this.state = reactiveState({ armed: null });
        onWillStart(() => this.refresh());
    }

    async refresh() {
        const status = await rpc("/oprof/status");
        this.state.armed = status.armed;
    }

    get recording() {
        return Boolean(this.state.armed);
    }

    get label() {
        return this.recording ? "vscodetool: recording your requests" : "vscodetool: not recording";
    }

    /** The switch: record every request of this user until switched off (one recording session). */
    async toggle() {
        const on = !this.recording;
        this.state.armed = await rpc("/oprof/arm", { count: on ? -1 : 0 });
        this.notification.add(
            on ? "Every request you make is recorded until you switch it off." : "Recording stopped.",
            { title: "vscodetool", type: "info" }
        );
    }

    openRuns() {
        this.action.doAction("oprof.oprof_run_action");
    }
}

if (owlLib.useState) {
    OprofSystray.props = {}; // Owl 2
}

export const systrayItem = {
    Component: OprofSystray,
    isDisplayed: () => user.isSystem,
};

registry.category("systray").add("oprof.systray", systrayItem, { sequence: 90 });
