import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { restart_from_here } from "./image_chooser_prompt.js";
import { hud, FlowState } from "./image_chooser_hud.js";
import { send_cancel, send_message, send_onstart, skip_next_restart_message } from "./image_chooser_messaging.js";
import { display_preview_images, additionalDrawBackground, click_is_in_image } from "./image_chooser_preview.js";

function progressButtonPressed() {
    const node = app.graph._nodes_by_id[this.node_id];
    if (this.name!='') {
        if (FlowState.paused()) {
            send_message(node.id, [...node.selected, -1, ...node.anti_selected]); 
        }
        if (FlowState.idle()) {
            skip_next_restart_message();
            restart_from_here(node.id).then(() => { send_message(node.id, [...node.selected, -1, ...node.anti_selected]); });
        }
    }
}

function cancelButtonPressed() { if (FlowState.running()) { send_cancel(); } }

/*
Comfy uses 'clicked' to make the button flash; so just disable that.
This *doesn't* stop the callback, it's totally cosmetic!
*/
function enable_disabling(button) {
    Object.defineProperty(button, 'clicked', {
        get : function() { return this._clicked; },
        set : function(v) { this._clicked = (v && this.name!=''); }
    })
}

app.registerExtension({
	name: "cg.custom.image_chooser",
    setup() {
        const draw = LGraphCanvas.prototype.draw;
        LGraphCanvas.prototype.draw = function() {
            if (hud.update()) {
                app.graph._nodes.forEach((node)=> { if (node.update) { node.update(); } })
            }
            draw.apply(this,arguments);
        }

        const original_api_interrupt = api.interrupt;
        api.interrupt = function () {
            if (FlowState.paused() && !FlowState.cancelling) send_cancel();
            original_api_interrupt.apply(this, arguments);
        }

        function earlyImageHandler(event) {
            display_preview_images(event);
        }
        api.addEventListener("early-image-handler", earlyImageHandler);
        api.addEventListener("execution_start", send_onstart);

        app.ui.settings.addSetting({
            id: "ImageChooser.hudpos",
            name: "Image Chooser HUD position (-1 for off)",
            type: "slider",
			attrs: {
				min: -1,
				max: 500,
				step: 1,
			},
            defaultValue: 10,
            onChange: (newVal, oldVal) => { hud.move(newVal); }
        });
    },

    async nodeCreated(node) {
        if (node?.comfyClass === "Preview Chooser" || node?.comfyClass === "Preview Chooser Fabric") {
            /* Don't allow imageIndex to be set - this stops images jumping to the front when clicked */
            Object.defineProperty(node, 'imageIndex', {
                get : function() { return null; },
                set : function( v ) { }
            })
            /* A property defining the top of the image when there is just one */
            Object.defineProperty(node, 'imagey', {
                get : function() { return this.widgets[this.widgets.length-1].last_y+LiteGraph.NODE_WIDGET_HEIGHT; }
            })

            /* Capture clicks */
            const org_onMouseDown = node.onMouseDown;
            node.onMouseDown = function( e, pos, canvas ) {
                if (e.isPrimary) {
                    const i = click_is_in_image(node, pos);
                    if (i>=0) { this.imageClicked(i); }
                }
                return (org_onMouseDown && org_onMouseDown.apply(this, arguments));
            }

            /* The buttons */
            node.cancel_button_widget = node.addWidget("button", "", "", cancelButtonPressed);
            node.send_button_widget = node.addWidget("button", "", "", progressButtonPressed);
            enable_disabling(node.cancel_button_widget)
            enable_disabling(node.send_button_widget)

            /* clean up saves from previous versions 
            const onAfterGraphConfigured = node.onAfterGraphConfigured;
            node.onAfterGraphConfigured = function () {
                onAfterGraphConfigured?.apply(this, arguments);
                if (parseInt(this.widgets_values[0])) { // we have an id hanging around...
                    this.widgets_values.splice(0,1).push('');
                    this.widgets[0].value = node.widgets[1].value;
                    this.widgets[1].value = '';
                }
            }*/
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeType?.comfyClass==="Preview Chooser" || nodeType?.comfyClass === "Preview Chooser Fabric") {
            //const onNodeCreated = nodeType.prototype.onNodeCreated;
            //nodeType.prototype.onNodeCreated = function() {
            //    onNodeCreated?.apply(this, arguments);
            //}

            /* Code to draw the boxes around selected images */
            const onDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function(ctx) {
                onDrawBackground.apply(this, arguments);
                additionalDrawBackground(this, ctx);
            }

            /* Code to handle clicks on images */
            nodeType.prototype.imageClicked = function (imageIndex) {
                if (nodeType?.comfyClass==="Preview Chooser") {
                    if (this.selected.has(imageIndex)) this.selected.delete(imageIndex);
                    else this.selected.add(imageIndex);
                } else {
                    if (this.selected.has(imageIndex)) {
                        this.selected.delete(imageIndex);
                        this.anti_selected.add(imageIndex);
                    } else if (this.anti_selected.has(imageIndex)) {
                        this.anti_selected.delete(imageIndex);
                    } else {
                        this.selected.add(imageIndex);
                    }
                }
                this.update();
            }

            /* Update the node when the flow state changes - change button labels */
            const update = nodeType.prototype.update;
            nodeType.prototype.update = function() {
                if (update) update.apply(this,arguments);
                if (this.send_button_widget) {
                    this.send_button_widget.node_id = this.id;
                    const selection = ( this.selected ? this.selected.size : 0 ) + ( this.anti_selected ? this.anti_selected.size : 0 )
                    if (FlowState.paused_here(this.id) && selection>0) {
                        this.send_button_widget.name = (selection>1) ? "Progress selected images" : "Progress selected image";
                    } else if (FlowState.idle() && selection>0) {
                        this.send_button_widget.name = (selection>1) ? "Progress selected images as restart" : "Progress selected image as restart";
                    } else if (FlowState.paused_here(this.id) && selection==0 && nodeType?.comfyClass === "Preview Chooser Fabric") {
                        this.send_button_widget.name = "Progress with nothing selected";
                    } else if (FlowState.idle() && selection==0 && nodeType?.comfyClass === "Preview Chooser Fabric") {
                        this.send_button_widget.name = "Progress with nothing selected as restart";
                    } else {
                        this.send_button_widget.name = "";
                    }
                }
                if (this.cancel_button_widget) this.cancel_button_widget.name = FlowState.running() ? "Cancel current run" : "";
                this.setDirtyCanvas(true,true); 
            }
        }
    },
});

