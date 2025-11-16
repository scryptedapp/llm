import sdk, { ScryptedDeviceType, ScryptedInterface, ScryptedUser, ScryptedUserAccessControl, Setting, SettingValue } from "@scrypted/sdk";
import { addAccessControlsForInterface, mergeDeviceAccessControls } from "@scrypted/sdk/acl";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import LLMPlugin from "./main";

export function getAllDevices<T>() {
    const ret = Object.keys(sdk.systemManager.getSystemState())
        .map(id => sdk.systemManager!.getDeviceById<T>(id));
    return ret;
}

export function getLLMs() {
    const ret = getAllDevices()
        .filter(device => (device.type === ScryptedDeviceType.LLM
            && device.interfaces?.includes(ScryptedInterface.ChatCompletion)));

    return ret;
}

export function getLLMsSettingsOnGetFilter() {
    return async () => {
        const llmIds = getLLMs().map(d => d.id);
        return {
            deviceFilter: `${JSON.stringify(llmIds)}.includes(id)`,
        }
    }
}

export class LLMUserMixin extends SettingsMixinDeviceBase<ScryptedUser> implements ScryptedUser {
    storageSettings = new StorageSettings(this, {
        accessAllLLMs: {
            title: 'LLM Access',
            description: 'Choose whether this user can access all LLMs, or only specific LLMs.',
            type: 'radiobutton',
            choices: [
                'Select Specific LLMs',
                'Access All LLMs',
            ],
            defaultValue: 'Select Specific LLMs',
        },
        llms: {
            radioGroups: ['Select Specific LLMs'],
            title: 'LLMs',
            description: 'LLMs that the user can access.',
            type: 'device',
            multiple: true,
            defaultValue: [],
        },
        admin: {
            title: 'Administrator',
            mapGet: () => '<div style="font-size: .8rem; margin-bottom: 16px; margin-left: 8px;">This user has administrator access to all LLMs.</div>',
            type: 'html',
            hide: true,
        },
    });
    _admin: boolean = false;

    constructor(public plugin: LLMPlugin, options: SettingsMixinDeviceOptions<ScryptedUser>) {
        super(options);

        this.storageSettings.settings.llms.onGet = getLLMsSettingsOnGetFilter();
    }

    async getIsAdmin() {
        if (this._admin !== undefined)
            return this._admin;
        this._admin = !(await this.mixinDevice.getScryptedUserAccessControl());
        if (this._admin) {
            this.storageSettings.settings.accessAllLLMs.hide = true;
            this.storageSettings.settings.llms.hide = true;
            this.storageSettings.settings.admin.hide = false;
        }
        return this._admin;
    }

    async createUserPreferences() {
        const user = `preferences:${this.id}`;

        await sdk.deviceManager.onDeviceDiscovered({
            nativeId: user,
            providerNativeId: 'users',
            name: `LLM Preferences: ${this.name}`,
            type: ScryptedDeviceType.Builtin,
            interfaces: [
                ScryptedInterface.Settings,
                ScryptedInterface.DeviceProvider,
                ScryptedInterface.DeviceCreator,
            ],
        });

    }

    async getScryptedUserAccessControl(): Promise<ScryptedUserAccessControl> {
        const ret = await this.mixinDevice.getScryptedUserAccessControl();

        mergeDeviceAccessControls(ret, [
            addAccessControlsForInterface(sdk.systemManager.getDeviceById('@scrypted/llm').id,
                ScryptedInterface.LauncherApplication,
                ScryptedInterface.ScryptedDevice,
                ScryptedInterface.HttpRequestHandler,
                ScryptedInterface.EngineIOHandler
            ),
        ]);

        mergeDeviceAccessControls(ret, [
            {
                id: sdk.systemManager.getDeviceById('@scrypted/llm').id,
                interfaces: ["UserDatabase"],
                methods: [
                    "openDatabase",
                ]
            }
        ]);

        let llms = this.storageSettings.values.llms as string[];
        if (this.storageSettings.values.accessAllLLMs === 'Access All LLMs') {
            llms = getLLMs().map(d => d.id);
        }

        for (const llm of llms) {
            mergeDeviceAccessControls(ret, [
                addAccessControlsForInterface(llm,
                    ScryptedInterface.ScryptedDevice,
                    ScryptedInterface.ChatCompletion,
                )
            ])
        }

        return ret;
    }


    async getMixinSettings(): Promise<Setting[]> {
        await this.getIsAdmin();
        return this.storageSettings.getSettings();
    }

    putMixinSetting(key: string, value: SettingValue): Promise<boolean | void> {
        return this.storageSettings.putSetting(key, value);
    }
}