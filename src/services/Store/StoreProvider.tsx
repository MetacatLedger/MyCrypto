import React, { createContext, useEffect, useState } from 'react';

import { DEFAULT_NETWORK } from '@config';
import { MembershipStatus } from '@features/PurchaseMembership/config';
import { ENSService } from '@services/ApiService';
import { UniClaimResult } from '@services/ApiService/Uniswap/Uniswap';
import { isEthereumAccount } from '@services/Store/Account';
import {
  addAccounts,
  deleteMembership,
  isMyCryptoMember,
  selectCurrentAccounts,
  useDispatch,
  useSelector
} from '@store';
import { translateRaw } from '@translations';
import {
  Asset,
  Bigish,
  DomainNameRecord,
  IAccount,
  IAccountAdditionData,
  Network,
  NetworkId,
  StoreAccount,
  StoreAsset,
  TAddress,
  TUuid,
  WalletId
} from '@types';
import {
  bigify,
  convertToFiatFromAsset,
  generateDeterministicAddressUUID,
  generateUUID,
  getWeb3Config
} from '@utils';
import { isEmpty } from '@vendor';

import { UniswapService } from '../ApiService';
import { useAccounts } from './Account';
import { getNewDefaultAssetTemplateByNetwork, getTotalByAsset, useAssets } from './Asset';
import { useContacts } from './Contact';
import { findMultipleNextUnusedDefaultLabels } from './Contact/helpers';
import { getNetworkById, useNetworks } from './Network';
import { useSettings } from './Settings';

interface IAddAccount {
  address: TAddress;
  dPath: string;
}

export interface State {
  readonly accounts: StoreAccount[];
  readonly networks: Network[];
  readonly isMyCryptoMember: boolean;
  readonly memberships?: MembershipStatus[];
  readonly currentAccounts: StoreAccount[];
  readonly uniClaims: UniClaimResult[];
  readonly ensOwnershipRecords: DomainNameRecord[];
  readonly isEnsFetched: boolean;
  readonly accountRestore: { [name: string]: IAccount | undefined };
  assets(selectedAccounts?: StoreAccount[]): StoreAsset[];
  totals(selectedAccounts?: StoreAccount[]): StoreAsset[];
  totalFiat(
    selectedAccounts?: StoreAccount[]
  ): (getAssetRate: (asset: Asset) => number | undefined) => Bigish;
  deleteAccountFromCache(account: IAccount): void;
  restoreDeletedAccount(accountId: TUuid): void;
  addMultipleAccounts(
    networkId: NetworkId,
    walletId: WalletId | undefined,
    accounts: IAccountAdditionData[]
  ): IAccount[] | undefined;
}
export const StoreContext = createContext({} as State);

// App Store that combines all data values required by the components such
// as accounts, currentAccount, tokens, and fiatValues etc.
export const StoreProvider: React.FC = ({ children }) => {
  const {
    accounts,
    getAccountByAddressAndNetworkName,
    deleteAccount,
    createMultipleAccountsWithIDs
  } = useAccounts();
  const { assets } = useAssets();
  const { settings, updateSettingsAccounts } = useSettings();
  const { networks } = useNetworks();
  const { createContact, contacts, getContactByAddressAndNetworkId, updateContact } = useContacts();
  const dispatch = useDispatch();

  const [accountRestore, setAccountRestore] = useState<{ [name: string]: IAccount | undefined }>(
    {}
  );

  const currentAccounts = useSelector(selectCurrentAccounts);

  const mainnetAccounts = accounts
    .filter((a) => a.networkId === DEFAULT_NETWORK)
    .map((a) => a.address);

  // Uniswap UNI token claims
  const [uniClaims, setUniClaims] = useState<UniClaimResult[]>([]);

  useEffect(() => {
    if (mainnetAccounts.length > 0) {
      UniswapService.instance.getClaims(mainnetAccounts).then((rawClaims) => {
        if (rawClaims !== null) {
          UniswapService.instance
            .isClaimed(networks.find((n) => n.id === DEFAULT_NETWORK)!, rawClaims)
            .then((claims) => {
              setUniClaims(claims);
            });
        }
      });
    }
  }, [mainnetAccounts.length]);

  const [ensOwnershipRecords, setEnsOwnershipRecords] = useState<DomainNameRecord[]>(
    [] as DomainNameRecord[]
  );
  const [isEnsFetched, setIsEnsFetched] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      setEnsOwnershipRecords(
        await ENSService.fetchOwnershipRecords(accounts.filter(isEthereumAccount))
      );
      setIsEnsFetched(true);
    })();
  }, [accounts.length]);

  const state: State = {
    accounts,
    networks,
    isMyCryptoMember: useSelector(isMyCryptoMember),
    currentAccounts,
    accountRestore,
    uniClaims,
    ensOwnershipRecords,
    isEnsFetched,
    assets: (selectedAccounts = state.accounts) =>
      selectedAccounts.flatMap((account: StoreAccount) => account.assets),
    totals: (selectedAccounts = state.accounts) =>
      Object.values(getTotalByAsset(state.assets(selectedAccounts))),
    totalFiat: (selectedAccounts = state.accounts) => (
      getAssetRate: (asset: Asset) => number | undefined
    ) =>
      state
        .totals(selectedAccounts)
        .reduce(
          (sum, asset) => sum.plus(bigify(convertToFiatFromAsset(asset, getAssetRate(asset)))),
          bigify(0)
        ),
    deleteAccountFromCache: (account) => {
      setAccountRestore((prevState) => ({ ...prevState, [account.uuid]: account }));
      deleteAccount(account);
      updateSettingsAccounts(
        settings.dashboardAccounts.filter((dashboardUUID) => dashboardUUID !== account.uuid)
      );
      dispatch(deleteMembership({ address: account.address, networkId: account.networkId }));
    },
    restoreDeletedAccount: (accountId) => {
      const account = accountRestore[accountId];
      if (isEmpty(account)) {
        throw new Error('Unable to restore account! No account with id specified.');
      }
      dispatch(addAccounts([account!]));
      setAccountRestore((prevState) => ({ ...prevState, [account!.uuid]: undefined }));
    },
    addMultipleAccounts: (
      networkId: NetworkId,
      accountType: WalletId | undefined,
      newAccounts: IAddAccount[]
    ) => {
      const network: Network | undefined = getNetworkById(networkId, networks);
      if (!network || newAccounts.length === 0) return;
      const accountsToAdd = newAccounts.filter(
        ({ address }) => !getAccountByAddressAndNetworkName(address, networkId)
      );
      const walletType =
        accountType! === WalletId.WEB3 ? WalletId[getWeb3Config().id] : accountType!;
      const newAsset: Asset = getNewDefaultAssetTemplateByNetwork(assets)(network);
      const newRawAccounts = accountsToAdd.map(({ address, dPath }) => ({
        address,
        networkId,
        wallet: walletType,
        dPath,
        assets: [{ uuid: newAsset.uuid, balance: '0', mtime: Date.now() }],
        transactions: [],
        favorite: false,
        mtime: 0,
        uuid: generateDeterministicAddressUUID(networkId, address)
      }));
      if (newRawAccounts.length === 0) return;
      const newLabels = findMultipleNextUnusedDefaultLabels(
        newRawAccounts[0].wallet,
        newRawAccounts.length
      )(contacts);
      newRawAccounts.forEach((rawAccount, idx) => {
        const existingContact = getContactByAddressAndNetworkId(rawAccount.address, networkId);
        if (existingContact && existingContact.label === translateRaw('NO_LABEL')) {
          updateContact({
            ...existingContact,
            label: newLabels[idx]
          });
        } else if (!existingContact) {
          const newLabel = {
            label: newLabels[idx],
            address: rawAccount.address,
            notes: '',
            network: rawAccount.networkId,
            uuid: generateUUID()
          };
          createContact(newLabel);
        }
      });
      createMultipleAccountsWithIDs(newRawAccounts);
      return newRawAccounts;
    }
  };

  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
};

export default StoreProvider;
